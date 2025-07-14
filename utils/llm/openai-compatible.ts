import { createOpenAI } from '@ai-sdk/openai'
import { wrapLanguageModel } from 'ai'

import { getUserConfig } from '@/utils/user-config'

import { ModelNotFoundError } from '../error'
import { makeCustomFetch } from '../fetch'

export async function getOpenAICompatibleClient() {
  const userConfig = await getUserConfig()
  const baseUrl = userConfig.llm.openaiCompatible.baseUrl.get()
  const apiKey = userConfig.llm.openaiCompatible.apiKey.get()

  if (!apiKey || apiKey.trim() === '') {
    throw new ModelNotFoundError('OpenAI Compatible API key is required')
  }

  const customFetch = makeCustomFetch({
    bodyTransformer: (body) => {
      if (typeof body !== 'string') return body
      const parsedBody = JSON.parse(body)

      // Add any OpenAI Compatible specific transformations here
      return JSON.stringify(parsedBody)
    },
  })

  const openai = createOpenAI({
    baseURL: baseUrl,
    apiKey: apiKey,
    fetch: customFetch,
  })

  return openai
}

export async function getOpenAICompatibleModel(options: {
  model: string
  numCtx: number
  reasoning: boolean
}) {
  const openai = await getOpenAICompatibleClient()

  const model = openai(options.model, {
    structuredOutputs: true,
  })

  // Apply reasoning middleware if needed
  return wrapLanguageModel({
    model,
    middleware: [], // Add reasoning middleware here if needed
  })
}

export async function testOpenAICompatibleConnection() {
  try {
    const userConfig = await getUserConfig()
    const model = userConfig.llm.openaiCompatible.model.get()

    const openai = await getOpenAICompatibleClient()

    // Test with a simple completion
    const testModel = openai(model)
    const result = await testModel.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Test' }] }],
      maxTokens: 1,
    })

    return { success: true, result }
  }
  catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}
