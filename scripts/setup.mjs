// Compatibility entry point for the Chinese management wizard.
import { createManager } from './manage.mjs';
const manager = createManager();
try { await manager.main(); } finally { manager.close(); }
