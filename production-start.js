'use strict';

/**
 * Production Entry Point for Render (Free Tier)
 * This script runs both the API Server and the Job Worker in the same process
 * to bypass Render's single-web-service constraint for free accounts.
 */

// Set environment to production
process.env.NODE_ENV = 'production';

// Import and start the API Server
console.log('🚀 Starting API Server...');
try {
  require('./api/src/server.js');
} catch (err) {
  console.error('❌ Failed to start API Server:', err);
}

// Import and start the Job Worker
// We delay this slightly to give the API time to initialize shared resources/db
setTimeout(() => {
  console.log('⚙️ Starting Job Worker...');
  try {
    require('./worker/src/worker.js');
  } catch (err) {
    console.error('❌ Failed to start Job Worker:', err);
  }
}, 2000);

console.log('✅ Combined Service initialized.');
