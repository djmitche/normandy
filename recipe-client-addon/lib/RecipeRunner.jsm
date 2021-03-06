/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {utils: Cu} = Components;
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://shield-recipe-client/lib/LogManager.jsm");
Cu.import("resource://shield-recipe-client/lib/NormandyDriver.jsm");
Cu.import("resource://shield-recipe-client/lib/FilterExpressions.jsm");
Cu.import("resource://shield-recipe-client/lib/NormandyApi.jsm");
Cu.import("resource://shield-recipe-client/lib/SandboxManager.jsm");
Cu.import("resource://shield-recipe-client/lib/ClientEnvironment.jsm");
Cu.import("resource://shield-recipe-client/lib/CleanupManager.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.importGlobalProperties(["fetch"]); /* globals fetch */

XPCOMUtils.defineLazyModuleGetter(this, "Preferences", "resource://gre/modules/Preferences.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Storage",
                                  "resource://shield-recipe-client/lib/Storage.jsm");
XPCOMUtils.defineLazyServiceGetter(this, "timerManager",
                                   "@mozilla.org/updates/timer-manager;1",
                                   "nsIUpdateTimerManager");

this.EXPORTED_SYMBOLS = ["RecipeRunner"];

const log = LogManager.getLogger("recipe-runner");
const prefs = Services.prefs.getBranch("extensions.shield-recipe-client.");
const TIMER_NAME = "recipe-client-addon-run";
const RUN_INTERVAL_PREF = "run_interval_seconds";

this.RecipeRunner = {
  init() {
    if (!this.checkPrefs()) {
      return;
    }

    if (prefs.getBoolPref("dev_mode")) {
      // Run right now in dev mode
      this.run();
    }

    this.updateRunInterval();
    CleanupManager.addCleanupHandler(() => timerManager.unregisterTimer(TIMER_NAME));

    // Watch for the run interval to change, and re-register the timer with the new value
    prefs.addObserver(RUN_INTERVAL_PREF, this, false);
    CleanupManager.addCleanupHandler(() => prefs.removeObserver(RUN_INTERVAL_PREF, this));
  },

  checkPrefs() {
    // Only run if Unified Telemetry is enabled.
    if (!Services.prefs.getBoolPref("toolkit.telemetry.unified")) {
      log.info("Disabling RecipeRunner because Unified Telemetry is disabled.");
      return false;
    }

    if (!prefs.getBoolPref("enabled")) {
      log.info("Recipe Client is disabled.");
      return false;
    }

    const apiUrl = prefs.getCharPref("api_url");
    if (!apiUrl || !apiUrl.startsWith("https://")) {
      log.error(`Non HTTPS URL provided for extensions.shield-recipe-client.api_url: ${apiUrl}`);
      return false;
    }

    return true;
  },

  /**
   * Watch for preference changes from Services.pref.addObserver.
   */
  observe(changedPrefBranch, action, changedPref) {
    if (action === "nsPref:changed" && changedPref === RUN_INTERVAL_PREF) {
      this.updateRunInterval();
    } else {
      log.debug(`Observer fired with unexpected pref change: ${action} ${changedPref}`);
    }
  },

  updateRunInterval() {
    // Run once every `runInterval` wall-clock seconds. This is managed by setting a "last ran"
    // timestamp, and running if it is more than `runInterval` seconds ago. Even with very short
    // intervals, the timer will only fire at most once every few minutes.
    const runInterval = prefs.getIntPref(RUN_INTERVAL_PREF);
    timerManager.registerTimer(TIMER_NAME, () => this.run(), runInterval);
  },

  async run() {
    this.clearCaches();
    // Unless lazy classification is enabled, prep the classify cache.
    if (!Preferences.get("extensions.shield-recipe-client.experiments.lazy_classify", false)) {
      await ClientEnvironment.getClientClassification();
    }

    let recipes;
    try {
      recipes = await NormandyApi.fetchRecipes({enabled: true});
    } catch (e) {
      const apiUrl = prefs.getCharPref("api_url");
      log.error(`Could not fetch recipes from ${apiUrl}: "${e}"`);
      return;
    }

    const recipesToRun = [];

    for (const recipe of recipes) {
      if (await this.checkFilter(recipe)) {
        recipesToRun.push(recipe);
      }
    }

    if (recipesToRun.length === 0) {
      log.debug("No recipes to execute");
    } else {
      for (const recipe of recipesToRun) {
        try {
          log.debug(`Executing recipe "${recipe.name}" (action=${recipe.action})`);
          await this.executeRecipe(recipe);
        } catch (e) {
          log.error(`Could not execute recipe ${recipe.name}:`, e);
        }
      }
    }
  },

  getFilterContext(recipe) {
    return {
      normandy: Object.assign(ClientEnvironment.getEnvironment(), {
        recipe: {
          id: recipe.id,
          arguments: recipe.arguments,
        },
      }),
    };
  },

  /**
   * Evaluate a recipe's filter expression against the environment.
   * @param {object} recipe
   * @param {string} recipe.filter The expression to evaluate against the environment.
   * @return {boolean} The result of evaluating the filter, cast to a bool, or false
   *                   if an error occurred during evaluation.
   */
  async checkFilter(recipe) {
    const context = this.getFilterContext(recipe);
    try {
      const result = await FilterExpressions.eval(recipe.filter_expression, context);
      return !!result;
    } catch (err) {
      log.error(`Error checking filter for "${recipe.name}"`);
      log.error(`Filter: "${recipe.filter_expression}"`);
      log.error(`Error: "${err}"`);
      return false;
    }
  },

  /**
   * Execute a recipe by fetching it action and executing it.
   * @param  {Object} recipe A recipe to execute
   * @promise Resolves when the action has executed
   */
  async executeRecipe(recipe) {
    const action = await NormandyApi.fetchAction(recipe.action);
    const response = await fetch(action.implementation_url);

    const actionScript = await response.text();
    await this.executeAction(recipe, actionScript);
  },

  /**
   * Execute an action in a sandbox for a specific recipe.
   * @param  {Object} recipe A recipe to execute
   * @param  {String} actionScript The JavaScript for the action to execute.
   * @promise Resolves or rejects when the action has executed or failed.
   */
  executeAction(recipe, actionScript) {
    return new Promise((resolve, reject) => {
      const sandboxManager = new SandboxManager();
      const prepScript = `
        function registerAction(name, Action) {
          let a = new Action(sandboxedDriver, sandboxedRecipe);
          a.execute()
            .then(actionFinished)
            .catch(actionFailed);
        };

        this.window = this;
        this.registerAction = registerAction;
        this.setTimeout = sandboxedDriver.setTimeout;
        this.clearTimeout = sandboxedDriver.clearTimeout;
      `;

      const driver = new NormandyDriver(sandboxManager);
      sandboxManager.cloneIntoGlobal("sandboxedDriver", driver, {cloneFunctions: true});
      sandboxManager.cloneIntoGlobal("sandboxedRecipe", recipe);

      // Results are cloned so that they don't become inaccessible when
      // the sandbox they came from is nuked when the hold is removed.
      sandboxManager.addGlobal("actionFinished", result => {
        const clonedResult = Cu.cloneInto(result, {});
        sandboxManager.removeHold("recipeExecution");
        resolve(clonedResult);
      });
      sandboxManager.addGlobal("actionFailed", err => {
        // Error objects can't be cloned, so we just copy the message
        // (which doesn't need to be cloned) to be somewhat useful.
        const message = err.message;
        sandboxManager.removeHold("recipeExecution");
        reject(new Error(message));
      });

      sandboxManager.addHold("recipeExecution");
      sandboxManager.evalInSandbox(prepScript);
      sandboxManager.evalInSandbox(actionScript);
    });
  },

  /**
   * Clear all caches of systems used by RecipeRunner, in preparation
   * for a clean run.
   */
  clearCaches() {
    ClientEnvironment.clearClassifyCache();
    NormandyApi.clearIndexCache();
  },

  /**
   * Clear out cached state and fetch/execute recipes from the given
   * API url. This is used mainly by the mock-recipe-server JS that is
   * executed in the browser console.
   */
  async testRun(baseApiUrl) {
    const oldApiUrl = prefs.getCharPref("api_url");
    prefs.setCharPref("api_url", baseApiUrl);

    try {
      Storage.clearAllStorage();
      this.clearCaches();
      await this.run();
    } finally {
      prefs.setCharPref("api_url", oldApiUrl);
      this.clearCaches();
    }
  },
};
