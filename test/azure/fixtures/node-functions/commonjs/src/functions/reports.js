const functions = require('@azure/functions');

async function nightlyReport(timer, context) {
  context.log('report', timer);
}

functions.app.timer('NightlyReport', { schedule: '0 0 2 * * *', handler: nightlyReport });

module.exports = { nightlyReport };
