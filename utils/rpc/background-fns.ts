import { generateObject as originalGenerateObject, GenerateObjectResult, generateText as originalGenerateText, streamObject as originalStreamObject, streamText as originalStreamText } from 'ai'
import { EventEmitter } from 'events'
import { Browser, browser } from 'wxt/browser'
import { z } from 'zod'

import logger from '@/utils/logger'

import { ContextMenuManager } from '../context-menu'
import { AppError, CreateTabStreamCaptureError, ModelRequestError, UnknownError } from '../error'
import { getModel, getModelUserConfig, ModelLoadingProgressEvent } from '../llm/models'
import { deleteModel, getLocalModelList, pullModel, showModelDetails } from '../llm/ollama'
import { SchemaName, Schemas, selectSchema } from '../llm/output-schema'
import { selectTools, ToolName } from '../llm/tools'
import { getWebLLMEngine, WebLLMSupportedModel } from '../llm/web-llm'
import { searchOnline } from '../search'
import { getUserConfig } from '../user-config'
import { bgBroadcastRpc } from '.'

type StreamTextOptions = Parameters<typeof originalStreamText>[0]
type GenerateTextOptions = Parameters<typeof originalGenerateText>[0]
type GenerateObjectOptions = Parameters<typeof originalGenerateObject>[0]

const preparePortConnection = (portName: string) => {
  return new Promise<Browser.runtime.Port>((resolve, reject) => {
    const onConnected = async (port: Browser.runtime.Port) => {
      if (port.name === portName) {
        browser.runtime.onConnect.removeListener(onConnected)
        resolve(port)
      }
    }
    browser.runtime.onConnect.addListener(onConnected)
    setTimeout(() => {
      browser.runtime.onConnect.removeListener(onConnected)
      reject(new Error('Timeout waiting for port connection'))
    }, 20000)
  })
}

const makeLoadingModelListener = (port: Browser.runtime.Port) => (ev: ModelLoadingProgressEvent) => {
  port.postMessage({
    type: 'loading-model',
    progress: ev,
  })
}

const normalizeError = (_error: unknown) => {
  let error
  if (_error instanceof AppError) {
    error = _error
  }
  else if (_error instanceof Error && _error.message.includes('Failed to fetch')) {
    error = new ModelRequestError(_error.message)
  }
  else {
    error = new UnknownError(`Unexpected error occurred during request: ${_error}`)
  }
  return error
}

const streamText = async (options: Pick<StreamTextOptions, 'messages' | 'prompt' | 'system' | 'toolChoice' | 'maxTokens'> & { tools?: ToolName[] }) => {
  const abortController = new AbortController()
  const portName = `streamText-${Date.now().toString(32)}`
  const onStart = async (port: Browser.runtime.Port) => {
    if (port.name !== portName) {
      return
    }
    browser.runtime.onConnect.removeListener(onStart)
    port.onDisconnect.addListener(() => {
      logger.debug('port disconnected from client')
      abortController.abort()
    })
    const response = originalStreamText({
      model: await getModel({ ...(await getModelUserConfig()), onLoadingModel: makeLoadingModelListener(port) }),
      messages: options.messages,
      prompt: options.prompt,
      system: options.system,
      tools: options.tools?.length ? selectTools(...options.tools) : undefined,
      toolChoice: options.toolChoice,
      maxTokens: options.maxTokens,
      abortSignal: abortController.signal,
    })
    for await (const chunk of response.fullStream) {
      if (chunk.type === 'error') {
        logger.error(chunk.error)
        port.postMessage({ type: 'error', error: normalizeError(chunk.error) })
      }
      else {
        port.postMessage(chunk)
      }
    }
    port.disconnect()
  }
  preparePortConnection(portName).then(onStart)
  return { portName }
}

const generateTextAsync = async (options: Pick<GenerateTextOptions, 'messages' | 'prompt' | 'system' | 'toolChoice' | 'maxTokens'> & { tools?: ToolName[] }) => {
  const response = originalGenerateText({
    model: await getModel({ ...(await getModelUserConfig()) }),
    messages: options.messages,
    prompt: options.prompt,
    system: options.system,
    tools: options.tools?.length ? selectTools(...options.tools) : undefined,
    toolChoice: options.toolChoice,
    maxTokens: options.maxTokens,
  })
  return response
}

const generateText = async (options: Pick<GenerateTextOptions, 'messages' | 'prompt' | 'system' | 'toolChoice' | 'maxTokens' | 'temperature' | 'topK' | 'topP'> & { tools?: ToolName[] }) => {
  const abortController = new AbortController()
  const portName = `streamText-${Date.now().toString(32)}`
  const onStart = async (port: Browser.runtime.Port) => {
    if (port.name !== portName) {
      return
    }
    browser.runtime.onConnect.removeListener(onStart)
    port.onDisconnect.addListener(() => {
      logger.debug('port disconnected from client')
      abortController.abort()
    })
    const response = await originalGenerateText({
      model: await getModel({ ...(await getModelUserConfig()) }),
      messages: options.messages,
      prompt: options.prompt,
      system: options.system,
      tools: options.tools?.length ? selectTools(...options.tools) : undefined,
      temperature: options.temperature,
      topK: options.topK,
      topP: options.topP,
      toolChoice: options.toolChoice,
      maxTokens: options.maxTokens,
      abortSignal: abortController.signal,
    })
    logger.debug('generateText response', response)
    port.postMessage(response)
    port.disconnect()
  }
  preparePortConnection(portName).then(onStart)
  return { portName }
}

const streamObjectFromSchema = async <S extends SchemaName>(options: Pick<GenerateObjectOptions, 'prompt' | 'system' | 'messages'> & { schema: S }) => {
  const abortController = new AbortController()
  const portName = `streamText-${Date.now().toString(32)}`
  const onStart = async (port: Browser.runtime.Port) => {
    if (port.name !== portName) {
      return
    }
    browser.runtime.onConnect.removeListener(onStart)
    port.onDisconnect.addListener(() => {
      logger.debug('port disconnected from client')
      abortController.abort()
    })
    const response = originalStreamObject({
      model: await getModel({ ...(await getModelUserConfig()), onLoadingModel: makeLoadingModelListener(port) }),
      output: 'object',
      schema: selectSchema(options.schema as SchemaName) as z.ZodSchema,
      prompt: options.prompt,
      system: options.system,
      messages: options.messages,
      abortSignal: abortController.signal,
    })
    for await (const chunk of response.fullStream) {
      if (chunk.type === 'error') {
        logger.error(chunk.error)
      }
      port.postMessage(chunk)
    }
    port.disconnect()
  }
  preparePortConnection(portName).then(onStart)
  return { portName }
}

const generateObjectFromSchema = async <S extends SchemaName>(options: Pick<GenerateObjectOptions, 'prompt' | 'system' | 'messages'> & { schema: S }) => {
  const userConfig = await getUserConfig()
  const endpointType = userConfig.llm.endpointType.get()

  // For OpenAI Compatible API, skip structured outputs and use regular text generation
  if (endpointType === 'openai-compatible') {
    const { generateText } = await import('ai')
    const model = await getModel({ ...(await getModelUserConfig()) })

    const s = selectSchema(options.schema)
    const isEnum = s instanceof z.ZodEnum

    let promptWithSchema: string
    if (isEnum) {
      const enumValues = (s as z.ZodEnum<[string, ...string[]]>)._def.values
      promptWithSchema = `${options.prompt}\n\nPlease respond with one of these exact values: ${enumValues.join(', ')}`
    }
    else {
      promptWithSchema = `${options.prompt}\n\nPlease respond with a valid JSON object that matches this schema. Only return the JSON object, no additional text.`
    }

    const result = await generateText({
      model,
      prompt: promptWithSchema,
      system: options.system,
      messages: options.messages,
    })

    try {
      const parsed = JSON.parse(result.text)
      return {
        object: parsed,
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        warnings: undefined,
        request: { body: '' },
        response: { headers: {}, status: 200, statusText: 'OK' },
        logprobs: undefined,
        providerMetadata: undefined,
        experimental_providerMetadata: undefined,
        toJsonResponse: () => ({ object: parsed }),
      } as unknown as GenerateObjectResult<z.infer<Schemas[S]>>
    }
    catch {
      // If JSON parsing fails, return the text as-is for enum cases
      if (isEnum) {
        const trimmedText = result.text.trim()
        return {
          object: trimmedText,
          finishReason: 'stop',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          warnings: undefined,
          request: { body: '' },
          response: { headers: {}, status: 200, statusText: 'OK' },
          logprobs: undefined,
          providerMetadata: undefined,
          experimental_providerMetadata: undefined,
          toJsonResponse: () => ({ object: trimmedText }),
        } as unknown as GenerateObjectResult<z.infer<Schemas[S]>>
      }
      throw new Error('Failed to parse JSON response from OpenAI Compatible API')
    }
  }

  const s = selectSchema(options.schema)
  const isEnum = s instanceof z.ZodEnum
  let ret
  try {
    if (isEnum) {
      ret = await originalGenerateObject({
        model: await getModel({ ...(await getModelUserConfig()) }),
        output: 'enum',
        enum: (s as z.ZodEnum<[string, ...string[]]>)._def.values,
        prompt: options.prompt,
        system: options.system,
        messages: options.messages,
      })
    }
    else {
      ret = await originalGenerateObject({
        model: await getModel({ ...(await getModelUserConfig()) }),
        output: 'object',
        schema: s as z.ZodSchema,
        prompt: options.prompt,
        system: options.system,
        messages: options.messages,
      })
    }
  }
  catch (error) {
    logger.error('Error generating object from schema:', error)
    throw normalizeError(error)
  }
  return ret as GenerateObjectResult<z.infer<Schemas[S]>>
}

const getAllTabs = async () => {
  const tabs = await browser.tabs.query({})
  return tabs.map((tab) => ({
    tabId: tab.id,
    title: tab.title,
    faviconUrl: tab.favIconUrl,
    url: tab.url,
  }))
}

const getDocumentContentOfTab = async (tabId: number) => {
  const article = await bgBroadcastRpc.getDocumentContent({ _toTab: tabId })
  return article
}

const fetchAsDataUrl = async (url: string, initOptions?: RequestInit) => {
  const response = await fetch(url, initOptions)
  if (!response.ok) {
    return {
      status: response.status,
      error: `Failed to fetch ${url}: ${response.statusText}`,
    }
  }

  const blob = await response.blob()
  return new Promise<{ status: number, dataUrl: string }>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const base64Data = reader.result as string
      resolve({
        status: response.status,
        dataUrl: base64Data,
      })
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

const fetchAsText = async (url: string, initOptions?: RequestInit) => {
  try {
    const response = await fetch(url, initOptions)
    if (!response.ok) {
      return {
        status: response.status,
        error: `Failed to fetch ${url}: ${response.statusText}`,
      }
    }

    const text = await response.text()
    return {
      status: response.status,
      text,
    }
  }
  catch (error) {
    return {
      status: 500,
      error: `Failed to fetch ${url}: ${error}`,
    }
  }
}

const deleteOllamaModel = async (modelId: string) => {
  await deleteModel(modelId)
}

const showOllamaModelDetails = async (modelId: string) => {
  return showModelDetails(modelId)
}

const pullOllamaModel = async (modelId: string) => {
  const abortController = new AbortController()
  const portName = `streamText-${Date.now().toString(32)}`
  const onStart = async (port: Browser.runtime.Port) => {
    if (port.name !== portName) {
      return
    }
    browser.runtime.onConnect.removeListener(onStart)
    port.onDisconnect.addListener(() => {
      logger.debug('port disconnected from client')
      abortController.abort()
    })
    const response = await pullModel(modelId)
    abortController.signal.addEventListener('abort', () => {
      response.abort()
    })
    try {
      for await (const chunk of response) {
        if (abortController.signal.aborted) {
          response.abort()
          break
        }
        port.postMessage(chunk)
      }
    }
    catch (error: unknown) {
      logger.debug('[pullOllamaModel] error', error)
      if (error instanceof Error) {
        port.postMessage({ error: error.message })
      }
      else {
        port.postMessage({ error: 'Unknown error' })
      }
    }
    port.disconnect()
  }
  browser.runtime.onConnect.addListener(onStart)
  setTimeout(() => {
    browser.runtime.onConnect.removeListener(onStart)
  }, 20000)
  return { portName }
}

async function testOllamaConnection() {
  const userConfig = await getUserConfig()
  try {
    const baseUrl = userConfig.llm.baseUrl.get()
    const origin = new URL(baseUrl).origin
    const response = await fetch(origin)
    if (!response.ok) return false
    const text = await response.text()
    if (text.includes('Ollama is running')) return true
    else return false
  }
  catch (error: unknown) {
    logger.error('error connecting to ollama api', error)
    return false
  }
}

function initWebLLMEngine(model: WebLLMSupportedModel) {
  try {
    const portName = `web-llm-${model}-${Date.now().toString(32)}`
    preparePortConnection(portName).then(async (port) => {
      port.onDisconnect.addListener(() => {
        logger.debug('port disconnected from client')
      })
      await getWebLLMEngine({
        model,
        contextWindowSize: 8192,
        onInitProgress: (progress) => {
          port.postMessage({ type: 'progress', progress })
        },
      })
      port.postMessage({ type: 'ready' })
    })
    return { portName }
  }
  catch (error) {
    logger.error('Error initializing WebLLM engine:', error)
    throw error
  }
}

type UnsupportedWebLLMReason = 'browser' | 'not_support_webgpu' | 'not_support_high_performance'
async function checkSupportWebLLM(): Promise<{ supported: boolean, reason?: UnsupportedWebLLMReason }> {
  if (import.meta.env.FIREFOX) {
    return {
      supported: false,
      reason: 'browser',
    }
  }
  if (!navigator.gpu) {
    return {
      supported: false,
      reason: 'not_support_webgpu',
    }
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    })
    const device = await adapter?.requestDevice()
    device?.destroy()
    return {
      supported: true,
    }
  }
  catch (error) {
    logger.debug('WebGPU not supported', error)
    return {
      supported: false,
      reason: 'not_support_high_performance',
    }
  }
}

async function getSystemMemoryInfo() {
  if (import.meta.env.FIREFOX) throw new Error('system.memory API is not supported in Firefox')
  return browser.system.memory.getInfo()
}

async function hasWebLLMModelInCache(model: WebLLMSupportedModel) {
  const { hasModelInCache } = await import('@mlc-ai/web-llm')
  const hasCache = await hasModelInCache(model)
  logger.debug('Checking cache for model', model, hasCache)
  return hasCache
}

async function deleteWebLLMModelInCache(model: WebLLMSupportedModel) {
  const { deleteModelInCache, hasModelInCache } = await import('@mlc-ai/web-llm')
  const hasCache = await hasModelInCache(model)
  logger.debug(`Deleting model ${model} from cache`, hasCache)
  try {
    await deleteModelInCache(model)
  }
  catch (error) {
    logger.error(`Failed to delete model ${model} from cache:`, error)
  }
}

async function isCurrentModelReady() {
  try {
    const userConfig = await getUserConfig()
    const endpointType = userConfig.llm.endpointType.get()
    const model = userConfig.llm.model.get()
    if (endpointType === 'ollama') return true
    else if (endpointType === 'openai-compatible') return true
    else if (endpointType === 'web-llm') {
      return await hasWebLLMModelInCache(model as WebLLMSupportedModel)
    }
    else throw new Error('Unsupported endpoint type ' + endpointType)
  }
  catch (error) {
    logger.error('Error checking current model readiness:', error)
    return false
  }
}

async function initCurrentModel() {
  const userConfig = await getUserConfig()
  const endpointType = userConfig.llm.endpointType.get()
  const model = userConfig.llm.model.get()
  if (endpointType === 'ollama') {
    return false
  }
  else if (endpointType === 'openai-compatible') {
    return false
  }
  else if (endpointType === 'web-llm') {
    const connectInfo = initWebLLMEngine(model as WebLLMSupportedModel)
    return connectInfo.portName
  }
  else {
    throw new Error('Unsupported endpoint type ' + endpointType)
  }
}

const eventEmitter = new EventEmitter()

export type Events = {
  ready: (tabId: number) => void
}

export type EventKey = keyof Events

export function registerBackgroundRpcEvent<E extends EventKey>(ev: E, fn: (...args: Parameters<Events[E]>) => void) {
  logger.debug('registering background rpc event', ev)
  eventEmitter.on(ev, fn)
  return () => {
    eventEmitter.off(ev, fn)
  }
}

function getTabCaptureMediaStreamId(tabId: number, consumerTabId?: number) {
  return new Promise<string | undefined>((resolve, reject) => {
    browser.tabCapture.getMediaStreamId(
      { targetTabId: tabId, consumerTabId },
      (streamId) => {
        if (browser.runtime.lastError) {
          logger.error('Failed to get media stream ID:', browser.runtime.lastError.message)
          reject(new CreateTabStreamCaptureError(browser.runtime.lastError.message))
        }
        else {
          resolve(streamId)
        }
      },
    )
  })
}

function captureVisibleTab(windowId?: number, options?: Browser.tabs.CaptureVisibleTabOptions) {
  const wid = windowId ?? browser.windows.WINDOW_ID_CURRENT
  const screenCaptureBase64Url = browser.tabs.captureVisibleTab(wid, options ?? {})
  return screenCaptureBase64Url
}

function ping() {
  return 'pong'
}

export const backgroundFunctions = {
  emit: <E extends keyof Events>(ev: E, ...args: Parameters<Events[E]>) => {
    eventEmitter.emit(ev, ...args)
  },
  ping,
  getTabInfo: (_tabInfo?: { tabId: number }) => _tabInfo as { tabId: number, title: string, faviconUrl?: string, url: string }, // a trick to get tabId
  generateText,
  generateTextAsync,
  streamText,
  getAllTabs,
  getLocalModelList,
  deleteOllamaModel,
  pullOllamaModel,
  showOllamaModelDetails,
  searchOnline,
  generateObjectFromSchema,
  getDocumentContentOfTab,
  fetchAsDataUrl,
  fetchAsText,
  streamObjectFromSchema,
  updateContextMenu: (...args: Parameters<ContextMenuManager['updateContextMenu']>) => ContextMenuManager.getInstance().then((manager) => manager.updateContextMenu(...args)),
  createContextMenu: (...args: Parameters<ContextMenuManager['createContextMenu']>) => ContextMenuManager.getInstance().then((manager) => manager.createContextMenu(...args)),
  deleteContextMenu: (...args: Parameters<ContextMenuManager['deleteContextMenu']>) => ContextMenuManager.getInstance().then((manager) => manager.deleteContextMenu(...args)),
  getTabCaptureMediaStreamId,
  initWebLLMEngine,
  hasWebLLMModelInCache,
  deleteWebLLMModelInCache,
  isCurrentModelReady,
  initCurrentModel,
  checkSupportWebLLM,
  getSystemMemoryInfo,
  testOllamaConnection,
  captureVisibleTab,
}
;(self as unknown as { backgroundFunctions: unknown }).backgroundFunctions = backgroundFunctions
