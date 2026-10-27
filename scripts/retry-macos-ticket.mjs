import { runMacosTicket } from './lib/macos-ticket-retry.mjs'

const [action, target, ...extra] = process.argv.slice(2)
if (!['staple', 'validate'].includes(action) || !target || extra.length) {
  console.error('Usage: node scripts/retry-macos-ticket.mjs <staple|validate> <target>')
  process.exit(2)
}

try {
  console.log(runMacosTicket(action, target))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
