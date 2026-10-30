const port = chrome.runtime.connect({ name: "tinyai-runtime-keepalive" });
port.onDisconnect.addListener(() => {
  setTimeout(() => chrome.runtime.connect({ name: "tinyai-runtime-keepalive" }), 1000);
});
