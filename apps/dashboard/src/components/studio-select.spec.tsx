import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StudioSelect } from './studio-select';

const OPTIONS = [
  { value: '', label: 'All' },
  { value: 'completed', label: 'Complete' },
  { value: 'partial', label: 'Partial' },
  { value: 'failed', label: 'Failed' },
] as const;

afterEach(cleanup);

describe('StudioSelect', () => {
  const setup = (value = '') => {
    const onChange = vi.fn();
    render(
      <StudioSelect
        id="status"
        label="Status"
        size="compact"
        value={value}
        options={OPTIONS}
        onChange={onChange}
      />,
    );
    return { onChange, trigger: screen.getByLabelText('Status') };
  };

  it('is a styled listbox, not a native select, and shows the current value', () => {
    const { trigger } = setup('partial');
    expect(document.querySelector('select')).toBeNull();
    expect(trigger.textContent).toContain('Partial');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens, marks and focuses the selected option, and reports the chosen value', () => {
    const { trigger, onChange } = setup('');
    fireEvent.click(trigger);
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent?.replace('✓', ''))).toEqual([
      'All',
      'Complete',
      'Partial',
      'Failed',
    ]);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(options[0]);
    fireEvent.click(options[3]!);
    expect(onChange).toHaveBeenCalledWith('failed');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('arrow keys move between options and Escape closes without choosing', () => {
    const { trigger, onChange } = setup('');
    fireEvent.click(trigger);
    const list = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(options[3]); // wraps around
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
