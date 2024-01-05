/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * SidebarUI controls showing and hiding the browser sidebar.
 */
var SidebarUI = {
  get sidebars() {
    if (this._sidebars) {
      return this._sidebars;
    }

    function makeSidebar({ elementId, ...rest }) {
      return {
        get sourceL10nEl() {
          return document.getElementById(elementId);
        },
        get title() {
          return document.getElementById(elementId).getAttribute("label");
        },
        ...rest,
      };
    }

    return (this._sidebars = new Map([
      [
        "viewBookmarksSidebar",
        makeSidebar({
          elementId: "sidebar-switcher-bookmarks",
          url: "chrome://browser/content/places/bookmarksSidebar.xhtml",
          menuId: "menu_bookmarksSidebar",
          iconurl: "chrome://global/skin/icons/bookmark-outline.svg",
        }),
      ],
      [
        "viewHistorySidebar",
        makeSidebar({
          elementId: "sidebar-switcher-history",
          url: "chrome://browser/content/places/historySidebar.xhtml",
          menuId: "menu_historySidebar",
          triggerButtonId: "appMenuViewHistorySidebar",
        }),
      ],
      [
        "viewTabsSidebar",
        makeSidebar({
          elementId: "sidebar-switcher-tabs",
          url: "chrome://browser/content/syncedtabs/sidebar.xhtml",
          menuId: "menu_tabsSidebar",
        }),
      ],
    ]));
  },

  // Avoid getting the browser element from init() to avoid triggering the
  // <browser> constructor during startup if the sidebar is hidden.
  get browser() {
    if (this._browser) {
      return this._browser;
    }
    return (this._browser = document.getElementById("sidebar"));
  },
  POSITION_START_PREF: "sidebar.position_start",
  DEFAULT_SIDEBAR_ID: "viewBookmarksSidebar",

  // lastOpenedId is set in show() but unlike currentID it's not cleared out on hide
  // and isn't persisted across windows
  lastOpenedId: null,

  _box: null,
  _sidebarTabs: null,
  _sidebarIcons: null,
  _sidebarContent: null,
  // The constructor of this label accesses the browser element due to the
  // control="sidebar" attribute, so avoid getting this label during startup.
  get _title() {
    if (this.__title) {
      return this.__title;
    }
    return (this.__title = document.getElementById("sidebar-title"));
  },
  _splitter: null,
  _reversePositionButton: null,
  _switcherPanel: null,
  _switcherTarget: null,
  _switcherArrow: null,
  _inited: false,

  /**
   * @type {MutationObserver | null}
   */
  _observer: null,

  _initDeferred: PromiseUtils.defer(),

  get promiseInitialized() {
    return this._initDeferred.promise;
  },

  get initialized() {
    return this._inited;
  },
  _generateUniquePanelID() {
    if (!this._uniquePanelIDCounter) {
      this._uniquePanelIDCounter = 0;
    }

    let outerID = window.docShell.outerWindowID;

    // We want panel IDs to be globally unique, that's why we include the
    // window ID. We switched to a monotonic counter as Date.now() lead
    // to random failures because of colliding IDs.
    return "sidebar-panel-" + outerID + "-" + ++this._uniquePanelIDCounter;
  },
  init() {
    this._box = document.getElementById("sidebar-box");
    this._sidebarTabs = document.getElementById("sidebar-container");
    this._sidebarIcons = document.getElementById("sidebar-icons");
    this._sidebarContent = document.getElementById("sidebar-tabpanels");
    this._splitter = document.getElementById("sidebar-splitter");
    this._reversePositionButton = document.getElementById(
      "sidebar-reverse-position"
    );
    this._switcherPanel = document.getElementById("sidebarMenu-popup");
    this._switcherTarget = document.getElementById("sidebar-switcher-target");
    this._switcherArrow = document.getElementById("sidebar-switcher-arrow");

    this._switcherTarget.addEventListener("command", () => {
      this.toggleSwitcherPanel();
    });
    this._switcherTarget.addEventListener("keydown", event => {
      this.handleKeydown(event);
    });

    this._inited = true;

    Services.obs.addObserver(this, "intl:app-locales-changed");

    this._initDeferred.resolve();

    const sidebarItemsKeys = this.sidebars.keys();

    // Adiciona todos os itens na barra lateral
    for(const sidebarItemKey of sidebarItemsKeys) {
      this.createSidebarItem(sidebarItemKey, this.sidebars.get(sidebarItemKey), true);
    }

    // Cria browser inicial
    let createOptions = {
      uriIsAboutBlank: false, //uriIsAboutBlank: false,
      userContextId: undefined, //userContextId,
      initialBrowsingContextGroupId: undefined, //initialBrowsingContextGroupId,
      remoteType: 'privilegedabout', //remoteType,
      openWindowInfo: null //openWindowInfo,
    };

    const {
      LOAD_FLAGS_NONE,
      LOAD_FLAGS_ALLOW_THIRD_PARTY_FIXUP,
      LOAD_FLAGS_FIXUP_SCHEME_TYPOS,
    } = Ci.nsIWebNavigation;

    let URILoadingWrapper = {
      _normalizeLoadURIOptions(browser, loadURIOptions) {
        if (!loadURIOptions.triggeringPrincipal) {
          throw new Error("Must load with a triggering Principal");
        }
  
        if (
          loadURIOptions.userContextId &&
          loadURIOptions.userContextId != browser.getAttribute("usercontextid")
        ) {
          throw new Error("Cannot load with mismatched userContextId");
        }
  
        loadURIOptions.loadFlags |= loadURIOptions.flags | LOAD_FLAGS_NONE;
        delete loadURIOptions.flags;
        loadURIOptions.hasValidUserGestureActivation ??=
          document.hasValidTransientUserGestureActivation;
      },
  
      _loadFlagsToFixupFlags(browser, loadFlags) {
        // Attempt to perform URI fixup to see if we can handle this URI in chrome.
        let fixupFlags = Ci.nsIURIFixup.FIXUP_FLAG_NONE;
        if (loadFlags & LOAD_FLAGS_ALLOW_THIRD_PARTY_FIXUP) {
          fixupFlags |= Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP;
        }
        if (loadFlags & LOAD_FLAGS_FIXUP_SCHEME_TYPOS) {
          fixupFlags |= Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS;
        }
        if (PrivateBrowsingUtils.isBrowserPrivate(browser)) {
          fixupFlags |= Ci.nsIURIFixup.FIXUP_FLAG_PRIVATE_CONTEXT;
        }
        return fixupFlags;
      },
  
      _fixupURIString(browser, uriString, loadURIOptions) {
        let fixupFlags = this._loadFlagsToFixupFlags(
          browser,
          loadURIOptions.loadFlags
        );
  
        // XXXgijs: If we switch to loading the URI we return from this method,
        // rather than redoing fixup in docshell (see bug 1815509), we need to
        // ensure that the loadURIOptions have the fixup flag removed here for
        // loads where `uriString` already parses if just passed immediately
        // to `newURI`.
        // Right now this happens in nsDocShellLoadState code.
        try {
          let fixupInfo = Services.uriFixup.getFixupURIInfo(
            uriString,
            fixupFlags
          );
          return fixupInfo.preferredURI;
        } catch (e) {
          // getFixupURIInfo may throw. Just return null, our caller will deal.
        }
        return null;
      },
  
      /**
       * Handles URIs when we want to deal with them in chrome code rather than pass
       * them down to a content browser. This can avoid unnecessary process switching
       * for the browser.
       * @param aBrowser the browser that is attempting to load the URI
       * @param aUri the nsIURI that is being loaded
       * @returns true if the URI is handled, otherwise false
       */
      _handleUriInChrome(aBrowser, aUri) {
        if (aUri.scheme == "file") {
          try {
            let mimeType = Cc["@mozilla.org/mime;1"]
              .getService(Ci.nsIMIMEService)
              .getTypeFromURI(aUri);
            if (mimeType == "application/x-xpinstall") {
              let systemPrincipal =
                Services.scriptSecurityManager.getSystemPrincipal();
              AddonManager.getInstallForURL(aUri.spec, {
                telemetryInfo: { source: "file-url" },
              }).then(install => {
                AddonManager.installAddonFromWebpage(
                  mimeType,
                  aBrowser,
                  systemPrincipal,
                  install
                );
              });
              return true;
            }
          } catch (e) {
            return false;
          }
        }
  
        return false;
      },
  
      _updateTriggerMetadataForLoad(
        browser,
        uriString,
        { loadFlags, globalHistoryOptions }
      ) {
        if (globalHistoryOptions?.triggeringSponsoredURL) {
          try {
            // Browser may access URL after fixing it up, then store the URL into DB.
            // To match with it, fix the link up explicitly.
            const triggeringSponsoredURL = Services.uriFixup.getFixupURIInfo(
              globalHistoryOptions.triggeringSponsoredURL,
              this._loadFlagsToFixupFlags(browser, loadFlags)
            ).fixedURI.spec;
            browser.setAttribute(
              "triggeringSponsoredURL",
              triggeringSponsoredURL
            );
            const time =
              globalHistoryOptions.triggeringSponsoredURLVisitTimeMS ||
              Date.now();
            browser.setAttribute("triggeringSponsoredURLVisitTimeMS", time);
          } catch (e) {}
        }
  
        if (globalHistoryOptions?.triggeringSearchEngine) {
          browser.setAttribute(
            "triggeringSearchEngine",
            globalHistoryOptions.triggeringSearchEngine
          );
          browser.setAttribute("triggeringSearchEngineURL", uriString);
        } else {
          browser.removeAttribute("triggeringSearchEngine");
          browser.removeAttribute("triggeringSearchEngineURL");
        }
      },
  
      // Both of these are used to override functions on browser-custom-element.
      fixupAndLoadURIString(browser, uriString, loadURIOptions = {}) {
        this._internalMaybeFixupLoadURI(browser, uriString, null, loadURIOptions);
      },
      loadURI(browser, uri, loadURIOptions = {}) {
        this._internalMaybeFixupLoadURI(browser, "", uri, loadURIOptions);
      },
  
      // A shared function used by both remote and non-remote browsers to
      // load a string URI or redirect it to the correct process.
      _internalMaybeFixupLoadURI(browser, uriString, uri, loadURIOptions) {
        this._normalizeLoadURIOptions(browser, loadURIOptions);
        // Some callers pass undefined/null when calling
        // loadURI/fixupAndLoadURIString. Just load about:blank instead:
        if (!uriString && !uri) {
          console.log("comecou com o google");
          uri = Services.io.newURI("https://google.com");
        }
  
        // We need a URI in frontend code for checking various things. Ideally
        // we would then also pass that URI to webnav/browsingcontext code
        // for loading, but we historically haven't. Changing this would alter
        // fixup scenarios in some non-obvious cases.
        let startedWithURI = !!uri;
        if (!uri) {
          // Note: this may return null if we can't make a URI out of the input.
          uri = this._fixupURIString(browser, uriString, loadURIOptions);
        }
  
        if (uri && this._handleUriInChrome(browser, uri)) {
          // If we've handled the URI in chrome, then just return here.
          return;
        }
  
        this._updateTriggerMetadataForLoad(
          browser,
          uriString || uri.spec,
          loadURIOptions
        );
  
        // XXX(nika): Is `browser.isNavigating` necessary anymore?
        // XXX(gijs): Unsure. But it mirrors docShell.isNavigating, but in the parent process
        // (and therefore imperfectly so).
        browser.isNavigating = true;
  
        try {
          // Should more generally prefer loadURI here - see bug 1815509.
          if (startedWithURI) {
            browser.webNavigation.loadURI(uri, loadURIOptions);
          } else {
            browser.webNavigation.fixupAndLoadURIString(
              uriString,
              loadURIOptions
            );
          }
        } finally {
          browser.isNavigating = false;
        }
      },
    };

    let browser = this.createBrowser(createOptions);
    browser.loadURI = URILoadingWrapper.loadURI.bind(
      URILoadingWrapper,
      browser
    );
    browser.fixupAndLoadURIString =
      URILoadingWrapper.fixupAndLoadURIString.bind(
        URILoadingWrapper,
        browser
      );

    let panel = browser.parentNode.parentNode.parentNode;
    panel.id = this._generateUniquePanelID();
    this._sidebarContent.append(panel);

    browser.docShellIsActive = true;

    console.log('criou browser do sidebar');
    // browser.loadURI('https://google.com', undefined);
  },

  async createSidebarItem(id, config, isinit = false) {
    if(!isinit) {
      await this.promiseInitialized();
    }

    // Se ja criou o elemento, ignora
    if(document.getElementById(`sidebar-background-${id}`)) {
      return;
    }

    const background = document.createXULElement("vbox");
    background.classList.add("sidebar-item-background");
    background.setAttribute("id", `sidebar-background-${id}`);

    const icon = document.createElement('image');
    icon.classList.add('sidebar-icon-item');
    icon.setAttribute('id', `sidebar-icon-${id}`);
    icon.setAttribute('src', `${config.iconurl}`);
    icon.style.backgroundImage = `url(${config.iconurl})`;

    background.append(icon);

    this._sidebarIcons.appendChild(background);
  },

  uninit() {
    // If this is the last browser window, persist various values that should be
    // remembered for after a restart / reopening a browser window.
    let enumerator = Services.wm.getEnumerator("navigator:browser");
    if (!enumerator.hasMoreElements()) {
      let xulStore = Services.xulStore;
      xulStore.persist(this._box, "sidebarcommand");

      if (this._box.hasAttribute("positionend")) {
        xulStore.persist(this._box, "positionend");
      } else {
        xulStore.removeValue(
          document.documentURI,
          "sidebar-box",
          "positionend"
        );
      }
      if (this._box.hasAttribute("checked")) {
        xulStore.persist(this._box, "checked");
      } else {
        xulStore.removeValue(document.documentURI, "sidebar-box", "checked");
      }

      xulStore.persist(this._box, "style");
      xulStore.persist(this._title, "value");
    }

    Services.obs.removeObserver(this, "intl:app-locales-changed");

    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
  },

  /**
   * The handler for Services.obs.addObserver.
   **/
  observe(_subject, topic, _data) {
    switch (topic) {
      case "intl:app-locales-changed": {
        if (this.isOpen) {
          // The <tree> component used in history and bookmarks, but it does not
          // support live switching the app locale. Reload the entire sidebar to
          // invalidate any old text.
          this.hide();
          this.showInitially(this.lastOpenedId);
          break;
        }
      }
    }
  },

  /**
   * Ensure the title stays in sync with the source element, which updates for
   * l10n changes.
   *
   * @param {HTMLElement} [element]
   */
  observeTitleChanges(element) {
    if (!element) {
      return;
    }
    let observer = this._observer;
    if (!observer) {
      observer = new MutationObserver(() => {
        this.title = this.sidebars.get(this.lastOpenedId).title;
      });
      // Re-use the observer.
      this._observer = observer;
    }
    observer.disconnect();
    observer.observe(element, {
      attributes: true,
      attributeFilter: ["label"],
    });
  },

  /**
   * Opens the switcher panel if it's closed, or closes it if it's open.
   */
  toggleSwitcherPanel() {
    if (
      this._switcherPanel.state == "open" ||
      this._switcherPanel.state == "showing"
    ) {
      this.hideSwitcherPanel();
    } else if (this._switcherPanel.state == "closed") {
      this.showSwitcherPanel();
    }
  },

  /**
   * Handles keydown on the the switcherTarget button
   * @param  {Event} event
   */
  handleKeydown(event) {
    switch (event.key) {
      case "Enter":
      case " ": {
        this.toggleSwitcherPanel();
        event.stopPropagation();
        event.preventDefault();
        break;
      }
      case "Escape": {
        this.hideSwitcherPanel();
        event.stopPropagation();
        event.preventDefault();
        break;
      }
    }
  },

  hideSwitcherPanel() {
    this._switcherPanel.hidePopup();
  },

  showSwitcherPanel() {
    this._switcherPanel.addEventListener(
      "popuphiding",
      () => {
        this._switcherTarget.classList.remove("active");
        this._switcherTarget.setAttribute("aria-expanded", false);
      },
      { once: true }
    );

    // Combine start/end position with ltr/rtl to set the label in the popup appropriately.
    let label =
      this._positionStart == RTL_UI
        ? gNavigatorBundle.getString("sidebar.moveToLeft")
        : gNavigatorBundle.getString("sidebar.moveToRight");
    this._reversePositionButton.setAttribute("label", label);

    // Open the sidebar switcher popup, anchored off the switcher toggle
    this._switcherPanel.hidden = false;
    this._switcherPanel.openPopup(this._switcherTarget);

    this._switcherTarget.classList.add("active");
    this._switcherTarget.setAttribute("aria-expanded", true);
  },

  updateShortcut({ keyId }) {
    let menuitem = this._switcherPanel.querySelector(`[key="${keyId}"]`);
    if (!menuitem) {
      // If the menu item doesn't exist yet then the accel text will be set correctly
      // upon creation so there's nothing to do now.
      return;
    }
    menuitem.removeAttribute("acceltext");
  },

  /**
   * Change the pref that will trigger a call to setPosition
   */
  reversePosition() {
    Services.prefs.setBoolPref(this.POSITION_START_PREF, !this._positionStart);
  },

  /**
   * Read the positioning pref and position the sidebar and the splitter
   * appropriately within the browser container.
   */
  setPosition() {
    // First reset all ordinals to match DOM ordering.
    let browser = document.getElementById("browser");
    [...browser.children].forEach((node, i) => {
      node.style.order = i + 1;
    });

    if (!this._positionStart) {
      // DOM ordering is:     |  sidebar-box  | splitter |   appcontent  |
      // Want to display as:  |   appcontent  | splitter |  sidebar-box  |
      // So we just swap box and appcontent ordering
      let appcontent = document.getElementById("appcontent");
      let boxOrdinal = this._sidebarTabs.style.order;
      this._sidebarTabs.style.order = appcontent.style.order;
      appcontent.style.order = boxOrdinal;
      // Indicate we've switched ordering to the box
      this._box.setAttribute("positionend", true);
    } else {
      this._box.removeAttribute("positionend");
    }

    this.hideSwitcherPanel();

    let content = SidebarUI.browser.contentWindow;
    if (content && content.updatePosition) {
      content.updatePosition();
    }
  },

  /**
   * Try and adopt the status of the sidebar from another window.
   * @param {Window} sourceWindow - Window to use as a source for sidebar status.
   * @return true if we adopted the state, or false if the caller should
   * initialize the state itself.
   */
  adoptFromWindow(sourceWindow) {
    // If the opener had a sidebar, open the same sidebar in our window.
    // The opener can be the hidden window too, if we're coming from the state
    // where no windows are open, and the hidden window has no sidebar box.
    let sourceUI = sourceWindow.SidebarUI;
    if (!sourceUI || !sourceUI._box) {
      // no source UI or no _box means we also can't adopt the state.
      return false;
    }

    // Set sidebar command even if hidden, so that we keep the same sidebar
    // even if it's currently closed.
    let commandID = sourceUI._box.getAttribute("sidebarcommand");
    if (commandID) {
      this._box.setAttribute("sidebarcommand", commandID);
    }

    if (sourceUI._box.hidden) {
      // just hidden means we have adopted the hidden state.
      return true;
    }

    // dynamically generated sidebars will fail this check, but we still
    // consider it adopted.
    if (!this.sidebars.has(commandID)) {
      return true;
    }

    this._box.style.width = sourceUI._box.getBoundingClientRect().width + "px";
    this.showInitially(commandID);

    return true;
  },

  windowPrivacyMatches(w1, w2) {
    return (
      PrivateBrowsingUtils.isWindowPrivate(w1) ===
      PrivateBrowsingUtils.isWindowPrivate(w2)
    );
  },

  /**
   * If loading a sidebar was delayed on startup, start the load now.
   */
  startDelayedLoad() {
    let sourceWindow = window.opener;
    // No source window means this is the initial window.  If we're being
    // opened from another window, check that it is one we might open a sidebar
    // for.
    if (sourceWindow) {
      if (
        sourceWindow.closed ||
        sourceWindow.location.protocol != "chrome:" ||
        !this.windowPrivacyMatches(sourceWindow, window)
      ) {
        return;
      }
      // Try to adopt the sidebar state from the source window
      if (this.adoptFromWindow(sourceWindow)) {
        return;
      }
    }

    // If we're not adopting settings from a parent window, set them now.
    let wasOpen = this._box.getAttribute("checked");
    if (!wasOpen) {
      return;
    }

    let commandID = this._box.getAttribute("sidebarcommand");
    if (commandID && this.sidebars.has(commandID)) {
      this.showInitially(commandID);
    } else {
      this._box.removeAttribute("checked");
      // Remove the |sidebarcommand| attribute, because the element it
      // refers to no longer exists, so we should assume this sidebar
      // panel has been uninstalled. (249883)
      // We use setAttribute rather than removeAttribute so it persists
      // correctly.
      this._box.setAttribute("sidebarcommand", "");
      // On a startup in which the startup cache was invalidated (e.g. app update)
      // extensions will not be started prior to delayedLoad, thus the
      // sidebarcommand element will not exist yet.  Store the commandID so
      // extensions may reopen if necessary.  A startup cache invalidation
      // can be forced (for testing) by deleting compatibility.ini from the
      // profile.
      this.lastOpenedId = commandID;
    }
  },

  /**
   * Fire a "SidebarShown" event on the sidebar to give any interested parties
   * a chance to update the button or whatever.
   */
  _fireShowEvent() {
    let event = new CustomEvent("SidebarShown", { bubbles: true });
    this._switcherTarget.dispatchEvent(event);
  },

  /**
   * Fire a "SidebarFocused" event on the sidebar's |window| to give the sidebar
   * a chance to adjust focus as needed. An additional event is needed, because
   * we don't want to focus the sidebar when it's opened on startup or in a new
   * window, only when the user opens the sidebar.
   */
  _fireFocusedEvent() {
    let event = new CustomEvent("SidebarFocused", { bubbles: true });
    this.browser.contentWindow.dispatchEvent(event);
  },

  /**
   * True if the sidebar is currently open.
   */
  get isOpen() {
    return !this._box.hidden;
  },

  /**
   * The ID of the current sidebar.
   */
  get currentID() {
    return this.isOpen ? this._box.getAttribute("sidebarcommand") : "";
  },

  get title() {
    return this._title.value;
  },

  set title(value) {
    this._title.value = value;
  },

  /**
   * Toggle the visibility of the sidebar. If the sidebar is hidden or is open
   * with a different commandID, then the sidebar will be opened using the
   * specified commandID. Otherwise the sidebar will be hidden.
   *
   * @param  {string}  commandID     ID of the sidebar.
   * @param  {DOMNode} [triggerNode] Node, usually a button, that triggered the
   *                                 visibility toggling of the sidebar.
   * @return {Promise}
   */
  toggle(commandID = this.lastOpenedId, triggerNode) {
    if (
      CustomizationHandler.isCustomizing() ||
      CustomizationHandler.isExitingCustomizeMode
    ) {
      return Promise.resolve();
    }
    // First priority for a default value is this.lastOpenedId which is set during show()
    // and not reset in hide(), unlike currentID. If show() hasn't been called and we don't
    // have a persisted command either, or the command doesn't exist anymore, then
    // fallback to a default sidebar.
    if (!commandID) {
      commandID = this._box.getAttribute("sidebarcommand");
    }
    if (!commandID || !this.sidebars.has(commandID)) {
      commandID = this.DEFAULT_SIDEBAR_ID;
    }

    if (this.isOpen && commandID == this.currentID) {
      this.hide(triggerNode);
      return Promise.resolve();
    }
    return this.show(commandID, triggerNode);
  },

  _loadSidebarExtension(commandID) {
    let sidebar = this.sidebars.get(commandID);
    let { extensionId } = sidebar;
    if (extensionId) {
      SidebarUI.browser.contentWindow.loadPanel(
        extensionId,
        sidebar.panel,
        sidebar.browserStyle
      );
    }
  },

  /**
   * Show the sidebar.
   *
   * This wraps the internal method, including a ping to telemetry.
   *
   * @param {string}  commandID     ID of the sidebar to use.
   * @param {DOMNode} [triggerNode] Node, usually a button, that triggered the
   *                                showing of the sidebar.
   * @return {Promise<boolean>}
   */
  async show(commandID, triggerNode) {
    let panelType = commandID.substring(4, commandID.length - 7);
    Services.telemetry.keyedScalarAdd("sidebar.opened", panelType, 1);

    // Extensions without private window access wont be in the
    // sidebars map.
    if (!this.sidebars.has(commandID)) {
      return false;
    }
    return this._show(commandID).then(() => {
      this._loadSidebarExtension(commandID);

      if (triggerNode) {
        updateToggleControlLabel(triggerNode);
      }

      this._fireFocusedEvent();
      return true;
    });
  },

  /**
   * Show the sidebar, without firing the focused event or logging telemetry.
   * This is intended to be used when the sidebar is opened automatically
   * when a window opens (not triggered by user interaction).
   *
   * @param {string} commandID ID of the sidebar.
   * @return {Promise<boolean>}
   */
  async showInitially(commandID) {
    let panelType = commandID.substring(4, commandID.length - 7);
    Services.telemetry.keyedScalarAdd("sidebar.opened", panelType, 1);

    // Extensions without private window access wont be in the
    // sidebars map.
    if (!this.sidebars.has(commandID)) {
      return false;
    }
    return this._show(commandID).then(() => {
      this._loadSidebarExtension(commandID);
      return true;
    });
  },

  /**
   * Implementation for show. Also used internally for sidebars that are shown
   * when a window is opened and we don't want to ping telemetry.
   *
   * @param {string} commandID ID of the sidebar.
   * @return {Promise<void>}
   */
  _show(commandID) {
    return new Promise(resolve => {
      this.selectMenuItem(commandID);

      this._box.hidden = this._splitter.hidden = false;
      this.setPosition();

      this.hideSwitcherPanel();

      this._box.setAttribute("checked", "true");
      this._box.setAttribute("sidebarcommand", commandID);
      this.lastOpenedId = commandID;

      let { url, title, sourceL10nEl } = this.sidebars.get(commandID);
      this.title = title;
      // Keep the title element in sync with any l10n changes.
      this.observeTitleChanges(sourceL10nEl);
      this.browser.setAttribute("src", url); // kick off async load

      if (this.browser.contentDocument.location.href != url) {
        this.browser.addEventListener(
          "load",
          event => {
            // We're handling the 'load' event before it bubbles up to the usual
            // (non-capturing) event handlers. Let it bubble up before resolving.
            setTimeout(() => {
              resolve();

              // Now that the currentId is updated, fire a show event.
              this._fireShowEvent();
            }, 0);
          },
          { capture: true, once: true }
        );
      } else {
        resolve();

        // Now that the currentId is updated, fire a show event.
        this._fireShowEvent();
      }
    });
  },

  /**
   * Hide the sidebar.
   *
   * @param {DOMNode} [triggerNode] Node, usually a button, that triggered the
   *                                hiding of the sidebar.
   */
  hide(triggerNode) {
    if (!this.isOpen) {
      return;
    }

    this.hideSwitcherPanel();

    this.selectMenuItem("");

    // Replace the document currently displayed in the sidebar with about:blank
    // so that we can free memory by unloading the page. We need to explicitly
    // create a new content viewer because the old one doesn't get destroyed
    // until about:blank has loaded (which does not happen as long as the
    // element is hidden).
    this.browser.setAttribute("src", "about:blank");
    this.browser.docShell.createAboutBlankDocumentViewer(null, null);

    this._box.removeAttribute("checked");
    this._box.hidden = this._splitter.hidden = true;

    let selBrowser = gBrowser.selectedBrowser;
    selBrowser.focus();
    if (triggerNode) {
      updateToggleControlLabel(triggerNode);
    }
  },

  /**
   * Sets the checked state only on the menu items of the specified sidebar, or
   * none if the argument is an empty string.
   */
  selectMenuItem(commandID) {
    for (let [id, { menuId, triggerButtonId }] of this.sidebars) {
      let menu = document.getElementById(menuId);
      let triggerbutton =
        triggerButtonId && document.getElementById(triggerButtonId);
      if (id == commandID) {
        menu.setAttribute("checked", "true");
        if (triggerbutton) {
          triggerbutton.setAttribute("checked", "true");
          updateToggleControlLabel(triggerbutton);
        }
      } else {
        menu.removeAttribute("checked");
        if (triggerbutton) {
          triggerbutton.removeAttribute("checked");
          updateToggleControlLabel(triggerbutton);
        }
      }
    }
  },

  createBrowser({
    isPreloadBrowser,
    name,
    openWindowInfo,
    remoteType,
    initialBrowsingContextGroupId,
    uriIsAboutBlank,
    userContextId,
    skipLoad,
    initiallyActive,
  } = {}) {
    let b = document.createXULElement("browser");
    // Use the JSM global to create the permanentKey, so that if the
    // permanentKey is held by something after this window closes, it
    // doesn't keep the window alive.
    b.permanentKey = new (Cu.getGlobalForObject(Services).Object)();

    // Ensure that SessionStore has flushed any session history state from the
    // content process before we this browser's remoteness.
    if (!Services.appinfo.sessionHistoryInParent) {
      b.prepareToChangeRemoteness = () =>
        SessionStore.prepareToChangeRemoteness(b);
      b.afterChangeRemoteness = switchId => {
        let tab = this.getTabForBrowser(b);
        SessionStore.finishTabRemotenessChange(tab, switchId);
        return true;
      };
    }

    const defaultBrowserAttributes = {
      contextmenu: "contentAreaContextMenu",
      message: "true",
      messagemanagergroup: "browsers",
      tooltip: "aHTMLTooltip",
      type: "content",
    };
    for (let attribute in defaultBrowserAttributes) {
      b.setAttribute(attribute, defaultBrowserAttributes[attribute]);
    }

    if (gMultiProcessBrowser || remoteType) {
      b.setAttribute("maychangeremoteness", "true");
    }

    if (!initiallyActive) {
      b.setAttribute("initiallyactive", "false");
    }

    if (userContextId) {
      b.setAttribute("usercontextid", userContextId);
    }

    if (remoteType) {
      b.setAttribute("remoteType", remoteType);
      b.setAttribute("remote", "true");
    }

    if (!isPreloadBrowser) {
      b.setAttribute("autocompletepopup", "PopupAutoComplete");
    }

    /*
     * This attribute is meant to describe if the browser is the
     * preloaded browser. When the preloaded browser is created, the
     * 'preloadedState' attribute for that browser is set to "preloaded", and
     * when a new tab is opened, and it is time to show that preloaded
     * browser, the 'preloadedState' attribute for that browser is removed.
     *
     * See more details on Bug 1420285.
     */
    if (isPreloadBrowser) {
      b.setAttribute("preloadedState", "preloaded");
    }

    // Ensure that the browser will be created in a specific initial
    // BrowsingContextGroup. This may change the process selection behaviour
    // of the newly created browser, and is often used in combination with
    // "remoteType" to ensure that the initial about:blank load occurs
    // within the same process as another window.
    if (initialBrowsingContextGroupId) {
      b.setAttribute(
        "initialBrowsingContextGroupId",
        initialBrowsingContextGroupId
      );
    }

    // Propagate information about the opening content window to the browser.
    if (openWindowInfo) {
      b.openWindowInfo = openWindowInfo;
    }

    // This will be used by gecko to control the name of the opened
    // window.
    if (name) {
      // XXX: The `name` property is special in HTML and XUL. Should
      // we use a different attribute name for this?
      b.setAttribute("name", name);
    }

    let notificationbox = document.createXULElement("notificationbox");
    notificationbox.setAttribute("notificationside", "top");

    let stack = document.createXULElement("stack");
    stack.className = "browserStack";
    stack.appendChild(b);

    let browserContainer = document.createXULElement("vbox");
    browserContainer.className = "browserContainer";
    browserContainer.appendChild(notificationbox);
    browserContainer.appendChild(stack);

    let browserSidebarContainer = document.createXULElement("hbox");
    browserSidebarContainer.className = "browserSidebarContainer";
    browserSidebarContainer.appendChild(browserContainer);

    // Prevent the superfluous initial load of a blank document
    // if we're going to load something other than about:blank.
    if (!uriIsAboutBlank || skipLoad) {
      b.setAttribute("nodefaultsrc", "true");
    }

    return b;
  }

};

// Add getters related to the position here, since we will want them
// available for both startDelayedLoad and init.
XPCOMUtils.defineLazyPreferenceGetter(
  SidebarUI,
  "_positionStart",
  SidebarUI.POSITION_START_PREF,
  true,
  SidebarUI.setPosition.bind(SidebarUI)
);
