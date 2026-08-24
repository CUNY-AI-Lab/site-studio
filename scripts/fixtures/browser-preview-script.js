import { childStatus } from './browser-child.js';

const status = document.querySelector('#module-status');
if (status) status.textContent = childStatus;
document.body.dataset.previewModule = 'loaded';
