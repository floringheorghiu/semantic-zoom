// settings-form.ts — settings window entry: theme sync + tab wiring.
import { initTheme } from '../state/theme';
import { initTabs } from './settings/tabs';
import { initInferenceTab } from './settings/inference-tab';

initTheme();
initTabs(document.body);
initInferenceTab();
