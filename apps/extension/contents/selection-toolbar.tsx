import cssText from 'data-text:~/style.css';
import type { PlasmoCSConfig, PlasmoGetShadowHostId } from 'plasmo';

import { SHADOW_HOST_ID } from '~/lib/selection/constants';
import { SelectionToolbar } from '~/lib/selection/components/selection-toolbar';

export const config: PlasmoCSConfig = {
  matches: ['<all_urls>'],
  all_frames: false,
  run_at: 'document_idle',
};

export const getShadowHostId: PlasmoGetShadowHostId = () => SHADOW_HOST_ID;

export const getStyle = () => {
  const style = document.createElement('style');
  style.textContent = cssText;
  return style;
};

export default function SelectionToolbarContent() {
  return <SelectionToolbar />;
}
