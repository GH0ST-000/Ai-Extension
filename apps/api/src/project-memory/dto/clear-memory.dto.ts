import { Equals } from 'class-validator';

import { StrictBoolean } from '../../common/validation/strict-boolean';

export class ClearProjectMemoryDto {
  /** Must be the JSON literal `true` (clearing is destructive; see StrictBoolean). */
  @StrictBoolean()
  @Equals(true, { message: 'confirm must be true to clear project memory' })
  confirm!: true;
}
