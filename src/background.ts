import { installKernelRuntimeGateway } from './runtime/chrome-runtime';

function setup(): void {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  } catch {
    // ignore
  }
}

chrome.action.onClicked.addListener((tab) => {
  try {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  } catch {
    // ignore
  }
});

chrome.runtime.onInstalled.addListener(() => setup());
chrome.runtime.onStartup.addListener(() => setup());
setup();
installKernelRuntimeGateway();
