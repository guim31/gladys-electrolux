// -----------------------------------------------------------------------------
// Entry point: the SDK client, the integration wired on it (src/app.js), the
// connection to Gladys. No logic here.
//
// The supervisor provides GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN and
// GLADYS_INTEGRATION_SELECTOR; the SDK reads them.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { createApp } from './src/app.js';

const gladys = new GladysIntegration();
const app = createApp({ gladys });

gladys.handleShutdown(() => app.stop());

logger.info('Starting the Electrolux / AEG integration');
gladys.connect().catch((err) => {
  logger.error(`Initial connection to Gladys failed (${err.message})`);
  process.exit(1);
});
