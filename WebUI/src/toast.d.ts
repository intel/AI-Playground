type ToastOptions = {
    mounted?: string|HTMLElement;
    style?: ToastStyle;
    settings?: ToastSettings;
  };
  
  type ToastStyle = {
    main?: KVObject;
    content?: KVObject;
  };
  
  type ToastSettings = {
    duration: number;
  };
  
  type ToastTransitions = {
    show: object;
    hide: object;
  };