import { logger, type Logger } from '@libp2p/logger'

const BASE_NAMESPACE = 'optimystic:fret'

export function createLogger(subNamespace: string): Logger {
	return logger(`${BASE_NAMESPACE}:${subNamespace}`)
}
