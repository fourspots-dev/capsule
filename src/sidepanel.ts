import { initKernelUi } from './sidepanel/kernel-panel';

async function init(): Promise<void> {
  try {
    await initKernelUi();
  } catch (error) {
    console.error('tinyai init failed', error);
    const root = document.querySelector('#root');
    if (root) {
      root.textContent = 'tinyai failed to start. Open chrome://extensions and reload the extension.';
    }
  }
}

init();
