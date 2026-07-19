// settings-form.ts — settings window entry: theme/accent sync + tab wiring.
import { initTheme } from '../state/theme';
import { initAccent } from '../state/accent';
import { initTabs } from './settings/tabs';
import { initInferenceTab } from './settings/inference-tab';
import { initGeneralTab } from './settings/general-tab';

initTheme();
initAccent();
initTabs(document.body);
initInferenceTab();
initGeneralTab();
