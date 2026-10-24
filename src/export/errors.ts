/** Thrown by an export the user cancelled (kept apart so the UI can check it without loading the renderer). */
export class ExportCancelledError extends Error {
  constructor() {
    super('EXPORT CANCELLED');
    this.name = 'ExportCancelledError';
  }
}
