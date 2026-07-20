// settings-form.ts — settings window entry: theme/accent sync + tab wiring.
import { initTheme } from '../state/theme';
import { initAccent } from '../state/accent';
import { initAnchorVisibility } from '../state/anchor-visibility';
import { initDensity } from '../state/density';
import { initTabs } from './settings/tabs';
import { initInferenceTab } from './settings/inference-tab';
import { initGeneralTab } from './settings/general-tab';
import { initPromptTab } from './settings/prompt-tab';

// Shares the main window's token system (accent/theme palette) instead of a
// parallel one, so a choice made here looks identical everywhere else. Pure
// CSS — no JS module graph crosses in from viewport/store/engine (D9/D10
// isolation is a JS-secrets concern, not a styling one).
import '../styles/tokens.css';
import '../styles/settings.css';

// `settings.html` loads this script as `type="module" defer`, so the DOM
// (including the static `#theme-group` markup) is already fully parsed
// before any of this runs. `initGeneralTab()` builds the theme radios and
// accent swatches and returns the callbacks that reflect an external pref
// change into them; call it first and hand each callback straight to its
// state module's init function.
const { reflectTheme, reflectAccent, reflectDensity } = initGeneralTab();
initTheme(reflectTheme);
initAccent(reflectAccent);
initDensity(reflectDensity);
initAnchorVisibility();
initTabs(document.body);
initInferenceTab();
void initPromptTab();
