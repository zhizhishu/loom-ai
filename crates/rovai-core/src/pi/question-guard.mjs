// Keep the existing file guard byte-for-byte intact. The managed question tool
// only interacts with the user; every other call still passes the original guard.
import fileGuard from './rovai-pi-file-guard.ts'
export default function questionGuard(pi) {
  return fileGuard(new Proxy(pi, {
    get(target, key) {
      if (key !== 'on') return Reflect.get(target, key)
      return (event, handler) => target.on(event, event === 'tool_call'
        ? (call, ctx) => call.toolName === 'ask_user_question' ? undefined : handler(call, ctx)
        : handler)
    }
  }))
}
