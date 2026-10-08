import pino from "pino";

let _logger: pino.Logger | undefined;

export function initLogger(level: string): pino.Logger {
  _logger = pino({
    level,
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
      },
    },
  });
  return _logger;
}

export function getLogger(name?: string): pino.Logger {
  if (!_logger) {
    _logger = pino({ level: "info" });
  }
  return name ? _logger.child({ component: name }) : _logger;
}
