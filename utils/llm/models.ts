import { extractReasoningMiddleware, LanguageModelV1, wrapLanguageModel } from 'ai'
import { createOllama } from 'ollama-ai-provider'

import { getUserConfig } from '@/utils/user-config'

import { ModelNotFoundError } from '../error'
import { makeCustomFetch } from '../fetch'
import { getOpenAICompatibleModel } from './openai-compatible'
import { WebLLMChatLanguageModel } from './providers/web-llm/openai-compatible-chat-language-model'
import { getWebLLMEngine, WebLLMSupportedModel } from './web-llm'

const reasoningMiddleware = extractReasoningMiddleware({
  tagName: 'think',
  separator: '\n\n',
  startWithReasoning: false,
})

export async function getModelUserConfig() {
  const userConfig = await getUserConfig()
  const endpointType = userConfig.llm.endpointType.get()
  const numCtx = userConfig.llm.numCtx.get()
  const reasoning = userConfig.llm.reasoning.get()

  let model: string | undefined
  let baseUrl: string
  let apiKey: string

  if (endpointType === 'openai-compatible') {
    model = userConfig.llm.openaiCompatible.model.get()
    baseUrl = userConfig.llm.openaiCompatible.baseUrl.get()
    apiKey = userConfig.llm.openaiCompatible.apiKey.get()
  }
  else {
    model = userConfig.llm.model.get()
    baseUrl = userConfig.llm.baseUrl.get()
    apiKey = userConfig.llm.apiKey.get()
  }

  if (!model) {
    throw new ModelNotFoundError()
  }
  return {
    baseUrl,
    model,
    apiKey,
    numCtx,
    reasoning,
  }
}

export type ModelLoadingProgressEvent = { type: 'loading', model: string, progress: number } | { type: 'finished' }

export async function getModel(options: {
  baseUrl: string
  model: string
  apiKey: string
  numCtx: number
  reasoning: boolean
  onLoadingModel?: (prg: ModelLoadingProgressEvent) => void
}) {
  const userConfig = await getUserConfig()
  let model: LanguageModelV1
  const endpointType = userConfig.llm.endpointType.get()
  if (endpointType === 'ollama') {
    const customFetch = makeCustomFetch({
      bodyTransformer: (body) => {
        // reasoning is enabled by default in Ollama
        if (options.reasoning) return body
        if (typeof body !== 'string') return body
        return JSON.stringify({
          ...JSON.parse(body),
          think: false, // disable reasoning
        })
      },
    })
    const ollama = createOllama({
      baseURL: new URL('/api', options.baseUrl).href,
      fetch: customFetch,
    })
    model = ollama(options.model, {
      numCtx: options.numCtx,
      structuredOutputs: true,
    })
  }
  else if (endpointType === 'web-llm') {
    const engine = await getWebLLMEngine({
      model: options.model as WebLLMSupportedModel,
      contextWindowSize: options.numCtx,
      onInitProgress(report) {
        options.onLoadingModel?.({ model: options.model, progress: report.progress, type: 'loading' })
      },
    })
    options.onLoadingModel?.({ type: 'finished' })
    model = new WebLLMChatLanguageModel(
      options.model,
      engine,
      {},
      { supportsStructuredOutputs: true, provider: 'web-llm', defaultObjectGenerationMode: 'json' },
    )
  }
  else if (endpointType === 'openai-compatible') {
    model = await getOpenAICompatibleModel({
      model: options.model,
      numCtx: options.numCtx,
      reasoning: options.reasoning,
    })
  }
  else {
    throw new Error('Unsupported endpoint type ' + endpointType)
  }
  return wrapLanguageModel({
    model,
    middleware: [reasoningMiddleware],
  })
}

export type LLMEndpointType = 'ollama' | 'web-llm' | 'openai-compatible'

export function parseErrorMessageFromChunk(error: unknown): string | null {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return null
}
