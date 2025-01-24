function mergeOptions(initialObj: KVObject, customObj: KVObject) {
    const newObj = initialObj ? Object.assign({}, initialObj) : {};
    for (const key in customObj) {
      const customProp = customObj[key];
      if (!customProp) {
        continue;
      }
      if (typeof customProp === "object") {
        newObj[key] = mergeOptions(newObj[key], customProp);
      } else {
        newObj[key] = customProp;
      }
    }
    return newObj;
  }
  
  /**
   * Stylize the Toast.
   */
  function stylize(element: HTMLElement, styles: KVObject) {
    Object.keys(styles).forEach((key) => {
      element.style.setProperty(key, styles[key]);
    });
  }
  
    const TOAST_ANIMATION_SPEED = 400;
  
    const DEFAULT_TRANSITIONS: ToastTransitions = {
      show: {
        transition: `opacity 0.5s`,
        opacity: "1",
      },
  
      hide: {
        opacity: "0",
        "-webkit-transform": "translateY(150%) translateZ(0)",
        transform: "translateY(150%) translateZ(0)",
        transition: `all ${TOAST_ANIMATION_SPEED}ms ease-in`,
      },
    };
  
    /**
     * The default Toast settings
     * @type {Object}
     */
    const DEFAULT_SETTINGS: ToastOptions = {
      mounted: "body",
      style: {
        main: {
          position: "fixed",
          left: "0px",
          top: "0px",
          width: "100%",
          height: "100%",
          "text-align": "center",
          "pointer-events": "none",
          opacity: "0",
          "z-index": "99999",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
        },
        content: {
          background: "#1677ff",
          "box-shadow": "0 0 10px rgba(0, 0, 0, .8)",
          "border-radius": "3px",
          "z-index": "99999",
          color: "rgba(255, 255, 255, .9)",
          "font-size": "14px",
          padding: "10px 15px",
          "max-width": "60%",
          "word-break": "keep-all",
          margin: "0px auto",
          "text-align": "center",
          display: "flex",
          "pointer-events": "none",
        },
      },
  
      settings: {
        duration: 4000,
      },
    };
  
    /**
     * The toastStage. This is the HTML element in which the toast resides
     * Getter and setter methods are available privately
     */
    let _toastStage: HTMLElement;
  
    /**
     * The Timeout object for animations.
     * This should be shared among the Toasts, because timeouts may be cancelled e.g. on explicit call of hide()
     */
    let _timeout: number;
  
    /**
     * The main Toast object
     * @param  text The text to put inside the Toast
     * @param options Optional; the Toast options. See Toast.prototype.DEFAULT_SETTINGS for more information
     * @param transitions Optional; the Transitions object. This should not be used unless you know what you're doing
     */
    export function show(
      text: string,
      options?: ToastOptions,
      transitions?: ToastTransitions
    ) {
      if (_toastStage != null) {
        // If there is already a Toast being shown, put this Toast in the queue to show later
        // toastQueue.push({ text, options, transitions: _transitions });
        if (_timeout) {
          window.clearTimeout(_timeout);
        }
        destroyToast();
      }
      const _options = mergeOptions(
        DEFAULT_SETTINGS,
        options || {}
      ) as ToastOptions;
  
      showToast(text, _options, transitions || DEFAULT_TRANSITIONS);
  
      return {
        hide: () => hideToast(transitions || DEFAULT_TRANSITIONS),
      };
    }
  
    export function success(text: string, settings?: ToastSettings) {
      show(text, {
        style: {
          content: { background: "#22c55e", color: "#ffffff" },
        },
        settings: settings,
      });
    }
  
    export function error(text: string, settings?: ToastSettings) {
      show(text, {
        style: {
          content: { background: "#ef4444", color: "#ffffff" },
        },
        settings: settings,
      });
    }
  
    export function warning(
      text: string,
      settings?: ToastSettings,
      mounted?: HTMLElement | string
    ) {
      show(text, {
        mounted,
        style: {
          content: { background: "#f97316", color: "#ffffff" },
        },
        settings: settings,
      });
    }
  
    /**
     * Show the Toast
     * @param  text The text to show inside the Toast
     * @param  options The object containing the options for the Toast
     */
    function showToast(
      text: string,
      options: ToastOptions,
      transitions: ToastTransitions
    ) {
      _toastStage = generateToast(text, options.style);
  
      const parentEL =
        options.mounted instanceof HTMLElement
          ? options.mounted
          : typeof options.mounted == "string"
          ? document.querySelector(options.mounted)
          : null;
      if (!parentEL) {
        throw new Error("options.mounted is undefine");
      }
      parentEL.appendChild(_toastStage);
  
      // This is a hack to get animations started. Apparently without explicitly redrawing, it'll just attach the class and no animations would be done.
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      _toastStage.offsetHeight;
  
      stylize(_toastStage, transitions.show);
  
      // Hide the Toast after the specified time
      // clearTimeout(timeout);
      if (options.settings && options.settings.duration !== 0) {
        _timeout = window.setTimeout(
          () => hideToast(transitions),
          options.settings.duration
        );
      }
    }
  
    /**
     * Hide the Toast that's currently shown.
     */
    function hideToast(transitions: ToastTransitions) {
      stylize(_toastStage, transitions.hide);
  
      // Destroy the Toast element after animations end.
      clearTimeout(_timeout);
      _timeout = 0;
      _toastStage.addEventListener("transitionend", destroyToast, { once: true });
    }
  
    /**
     * Generate the Toast with the specified text.
     * @param  text The text to show inside the Toast, can be an HTML element or plain text
     * @param  style The style to set for the Toast
     */
    function generateToast(text: string, style?: ToastStyle) {
      const content = document.createElement("div");
      const toastStage = document.createElement("div");
      const textNode = document.createTextNode(text);
      content.appendChild(textNode);
      toastStage.appendChild(content);
      if (style) {
        if (style.content) {
          stylize(content, style.content);
        }
        if (style.main) {
          stylize(toastStage, style.main);
        }
      }
      return toastStage;
    }
  
    /**
     * Clean up after the Toast slides away. Namely, removing the Toast from the DOM.
     * After the Toast is cleaned up, display the next Toast in the queue if any exists.
     */
    function destroyToast() {
      _toastStage.remove();
    }
