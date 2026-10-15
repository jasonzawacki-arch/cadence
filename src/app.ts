// Entry point: read the bundled demo (a real public repository's history) and start the screens.
import type { Data } from './model.js';
import { readData } from './data.js';
import { mount } from './ui.js';

const demo: Data = readData(document.getElementById('demo-data')!.textContent || '{}');
mount(demo);
