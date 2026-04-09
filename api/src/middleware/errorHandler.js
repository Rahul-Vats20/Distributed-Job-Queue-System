'use strict';
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  if (req.logger) req.logger.error({ err }, message);
  else console.error(err);
  res.status(status).json({ error: message });
}
module.exports = { errorHandler };
