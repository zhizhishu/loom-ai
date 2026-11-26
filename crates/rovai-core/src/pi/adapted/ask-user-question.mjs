// Adapted from earendil-works/pi f9a26365568127461c47a07a37dcb42c140a3ac5
// packages/coding-agent/examples/extensions/questionnaire.ts (MIT; adjacent LICENSE).
// Schema/defaults/answer envelope follow the official example; RPC uses sequential select/input.
export default function askUserQuestion(pi) {
  pi.registerTool({
    name: 'ask_user_question',
    label: 'Ask user question',
    description: 'Ask the user one or more questions to clarify requirements, preferences, or decisions.',
    parameters: {
      type: 'object', required: ['questions'],
      properties: { questions: { type: 'array', items: {
        type: 'object', required: ['id', 'prompt', 'options'],
        properties: {
          id: { type: 'string', description: 'Unique question identifier' },
          label: { type: 'string', description: 'Short label; defaults to Q1, Q2' },
          prompt: { type: 'string' },
          options: { type: 'array', items: {
            type: 'object', required: ['value', 'label'],
            properties: { value: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' } }
          } },
          allowOther: { type: 'boolean', description: 'Allow a custom answer; defaults to true' }
        }
      } } }
    },
    async execute(_id, params, signal, _update, ctx) {
      const questions = params.questions.map((question, index) => ({
        ...question, label: question.label || `Q${index + 1}`, allowOther: question.allowOther !== false
      }))
      const answers = []
      const result = (cancelled, text) => ({
        content: [{ type: 'text', text }], details: { questions, answers, cancelled }
      })
      if (!ctx.hasUI) return result(true, 'Error: UI not available')
      if (!questions.length) return result(true, 'Error: No questions provided')
      if (new Set(questions.map(q => q.id)).size !== questions.length) {
        return result(true, 'Error: Question identifiers must be unique')
      }
      const cancel = () => result(true, 'User cancelled the questionnaire')
      for (const question of questions) {
        if (signal?.aborted) return cancel()
        const options = question.options.map((option, index) =>
          `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`)
        const other = `${options.length + 1}. Type something.`
        if (question.allowOther) options.push(other)
        if (!options.length) return result(true, 'Error: Question has no available answers')
        const title = `${question.label}: ${question.prompt}`
        const selected = await ctx.ui.select(title, options, { signal })
        if (selected === undefined || signal?.aborted) return cancel()
        if (question.allowOther && selected === other) {
          const text = await ctx.ui.input(title, 'Your answer', { signal })
          if (text === undefined || signal?.aborted) return cancel()
          const value = text.trim() || '(no response)'
          answers.push({ id: question.id, value, label: value, wasCustom: true })
        } else {
          const index = options.indexOf(selected)
          const option = question.options[index]
          if (!option) return cancel()
          answers.push({ id: question.id, value: option.value, label: option.label, wasCustom: false, index: index + 1 })
        }
      }
      return result(false, answers.map(answer => {
        const label = questions.find(q => q.id === answer.id).label
        return answer.wasCustom ? `${label}: user wrote: ${answer.label}`
          : `${label}: user selected: ${answer.index}. ${answer.label}`
      }).join('\n'))
    }
  })
}
