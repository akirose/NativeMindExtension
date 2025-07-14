import { Browser, browser } from 'wxt/browser'
import { storage } from 'wxt/utils/storage'

import { nonNullable } from './array'
import { CONTEXT_MENU_STORAGE_KEY } from './constants'
import logger from './logger'
import { Entrypoint, only } from './runtime'
import { ArrayNonEmpty } from './type-utils'

const log = logger.child('context-menu')

export type ContextMenuId = 'native-mind-page-translate' | 'native-mind-selection-translate' | 'native-mind-settings' | 'native-mind-quick-actions' | `native-mind-quick-actions-${number}` | 'native-mind-root-menu'
export type ContextTypeList = ArrayNonEmpty<Browser.contextMenus.ContextType>

export type ContextMenuItem = {
  id: ContextMenuId
  title: string
  contexts: ContextTypeList
}

const ContextType = only([Entrypoint.background], () => browser.contextMenus.ContextType)
export const CONTEXT_MENU_ITEM_TRANSLATE_SELECTED_TEXT: ContextMenuItem = only([Entrypoint.background], () => ({
  id: 'native-mind-selection-translate',
  title: 'Translate selected text',
  contexts: [ContextType.SELECTION],
}))

export const CONTEXT_MENU_ITEM_TRANSLATE_PAGE: ContextMenuItem = only([Entrypoint.background], () => ({
  id: 'native-mind-page-translate',
  title: 'Translate this page',
  contexts: [ContextType.PAGE],
}))

export const CONTEXT_MENU_ITEM_SETTINGS: ContextMenuItem = only([Entrypoint.background], () => ({
  id: 'native-mind-settings',
  title: 'Settings',
  contexts: [ContextType?.ACTION],
}))

export const CONTEXT_MENU: ContextMenuItem[] = [
  CONTEXT_MENU_ITEM_TRANSLATE_PAGE,
  CONTEXT_MENU_ITEM_TRANSLATE_SELECTED_TEXT,
  CONTEXT_MENU_ITEM_SETTINGS,
]

export type ContextMenu = typeof CONTEXT_MENU

type ContextMenuMapItem = {
  id: ContextMenuId | undefined // undefined for root menu
  title?: string
  contexts?: ContextTypeList
  visible: boolean
  parentId?: ContextMenuId
  children: ContextMenuId[]
}

export class ContextMenuManager {
  private static instance: ContextMenuManager | null = null
  private reconstructing = false
  private pendingReconstruct = false
  private constructor() {}

  static async getInstance() {
    if (!ContextMenuManager.instance) {
      ContextMenuManager.instance = new ContextMenuManager()
      await ContextMenuManager.instance.restoreCurrentMenuMap()
    }
    return ContextMenuManager.instance
  }

  currentMenuMap = new Map<ContextMenuId | undefined, ContextMenuMapItem>()

  private saveCurrentMenuMap() {
    return storage.setItem(CONTEXT_MENU_STORAGE_KEY, [...this.currentMenuMap.entries()])
  }

  private safeContextMenuOperation<T>(operation: () => T, operationName: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try {
        const result = operation()
        resolve(result)
      }
      catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
          log.warn(`Extension context invalidated during ${operationName} - this is expected during development`)
          resolve(undefined as T)
        }
        else {
          log.error(`Failed to ${operationName}:`, error)
          reject(error)
        }
      }
    })
  }

  private createMenuItem(params: Browser.contextMenus.CreateProperties) {
    return this.safeContextMenuOperation(() => {
      return new Promise<void>((resolve, reject) => {
        browser.contextMenus.create(params, () => {
          if (browser.runtime.lastError) {
            const error = browser.runtime.lastError
            if (error.message?.includes('Extension context invalidated')) {
              log.warn('Extension context invalidated while creating context menu - this is expected during development')
              resolve()
            }
            else {
              log.error('Failed to create context menu:', error)
              reject(error)
            }
          }
          else {
            resolve()
          }
        })
      })
    }, 'create context menu').then((result) => result || Promise.resolve())
  }

  private removeAllMenuItems() {
    return this.safeContextMenuOperation(() => {
      return browser.contextMenus.removeAll()
    }, 'remove all context menus')
  }

  private async restoreCurrentMenuMap() {
    const storedMap = await storage.getItem<[ContextMenuId | undefined, ContextMenuMapItem][]>(CONTEXT_MENU_STORAGE_KEY)
    if (storedMap) {
      this.currentMenuMap = new Map<ContextMenuId | undefined, ContextMenuMapItem>(storedMap.map(([id, item]) => [id ?? undefined, item]))
      log.debug('Restored context menu map from storage', structuredClone(this.currentMenuMap))
    }
    else {
      log.debug('No stored context menu map found, starting with an empty map')
    }
  }

  private async reconstructContextMenu() {
    if (this.reconstructing) {
      this.pendingReconstruct = true
      log.debug('Context menu is being reconstructed, pending...')
      return
    }
    this.reconstructing = true
    await this.saveCurrentMenuMap()
    try {
      log.debug('Reconstructing context menu', this.currentMenuMap)
      await this.removeAllMenuItems()
      const firstLevelMenus = Array.from(this.currentMenuMap.values()).filter((item) => item.parentId === undefined)
      const reconstructMenuItem = async (parentId: string | undefined, items: ContextMenuMapItem[], titlePrefix?: string) => {
        for (const item of items) {
          await this.createMenuItem({
            id: item.id,
            title: `${titlePrefix || ''}${item.title}`,
            contexts: item.contexts,
            parentId,
            visible: item.visible,
          }).catch((error) => {
            log.error('Failed to create context menu item', item.id, error)
          })
          const children = item.children.map((childId) => this.currentMenuMap.get(childId)).filter(nonNullable)
          await reconstructMenuItem(item.id, children)
        }
      }

      // context menu belongs to the same group can not display in the same level at the same time
      const contextTypeGroup: Record<ContextTypeList[0], number> = {
        [ContextType.ALL]: 0,
        [ContextType.PAGE]: 1,
        [ContextType.SELECTION]: 1,
        [ContextType.LINK]: 1,
        [ContextType.IMAGE]: 1,
        [ContextType.AUDIO]: 1,
        [ContextType.VIDEO]: 1,
        [ContextType.FRAME]: 1,
        [ContextType.BROWSER_ACTION]: 1,
        [ContextType.PAGE_ACTION]: 1,
        [ContextType.EDITABLE]: 1,
        [ContextType.ACTION]: 2,
        [ContextType.LAUNCHER]: 3,
      }
      const groups = new Set()
      for (const m of firstLevelMenus) {
        if (!m.visible) continue
        if (!m.contexts) {
          groups.add(contextTypeGroup[ContextType.SELECTION])
        }
        else {
          m.contexts.forEach((context) => {
            groups.add(contextTypeGroup[context])
          })
        }
      }
      groups.delete(contextTypeGroup[ContextType.ACTION])
      if (groups.size > 1) {
        await this.createMenuItem({
          id: 'native-mind-root-menu',
          title: 'NativeMind',
          contexts: ['all'],
        }).catch((error) => {
          log.error('Failed to create root context menu:', error)
        })
        await reconstructMenuItem('native-mind-root-menu', firstLevelMenus)
      }
      else {
        await reconstructMenuItem(undefined, firstLevelMenus, 'NativeMind: ')
      }

      if (import.meta.env.FIREFOX) {
        await browser.menus.refresh()
      }
    }
    catch (error) {
      log.error('Error reconstructing context menu:', error)
    }
    finally {
      this.reconstructing = false
      if (this.pendingReconstruct) {
        this.pendingReconstruct = false
        await this.reconstructContextMenu()
      }
    }
  }

  async updateContextMenu(id: ContextMenuId, props: Omit<Browser.contextMenus.CreateProperties, 'id'>) {
    if (!this.currentMenuMap.has(id)) {
      log.warn('Context menu with id does not exist, creating instead', id)
      await this.createContextMenu(id, props)
      return
    }
    const parentId = props.parentId as ContextMenuId | undefined
    const r = this.currentMenuMap.get(id)!
    if (r.parentId !== parentId) {
      const oldParentId = r.parentId
      const parentItem = this.currentMenuMap.get(parentId)
      const oldParentItem = this.currentMenuMap.get(oldParentId)
      if (parentItem) {
        parentItem.children.push(id)
      }
      if (oldParentItem) {
        oldParentItem.children = oldParentItem.children.filter((childId) => childId !== id)
      }
    }
    r.parentId = (props.parentId ?? r.parentId) as ContextMenuId | undefined
    r.title = props.title ?? r.title
    r.contexts = (props.contexts ?? r.contexts) as ContextTypeList
    r.visible = props.visible ?? true
    log.debug('Updating context menu', id, props, structuredClone(this.currentMenuMap))
    await this.reconstructContextMenu()
  }

  async createContextMenu(id: ContextMenuId, props: Omit<Browser.contextMenus.CreateProperties, 'id'>) {
    if (this.currentMenuMap.has(id)) {
      log.warn('Context menu with id already exists, updating instead', id)
      await this.updateContextMenu(id, props)
      return
    }
    const parentId = props.parentId as ContextMenuId | undefined
    const visible = props.visible ?? true
    const item: ContextMenuMapItem = {
      id,
      title: props.title,
      contexts: props.contexts as ContextTypeList,
      visible,
      parentId,
      children: [],
    }
    this.currentMenuMap.set(id, item)
    if (parentId) {
      const parentItem = this.currentMenuMap.get(parentId)
      if (!parentItem) {
        log.error('Parent context menu not found for', id, 'parentId:', parentId, structuredClone(this.currentMenuMap))
      }
      else {
        parentItem.children.push(id)
      }
    }
    log.debug('Creating context menu', id, props, structuredClone(this.currentMenuMap))
    await this.reconstructContextMenu()
  }

  private recursiveDeleteContextMenu(id: ContextMenuId, deleted = new Set<ContextMenuId>()) {
    if (deleted.has(id)) {
      log.error('Recursive deletion detected for context menu', id, structuredClone(this.currentMenuMap))
      return
    }
    const item = this.currentMenuMap.get(id)
    if (!item) return
    this.currentMenuMap.delete(id)
    deleted.add(id)
    if (item.children.length) {
      for (const childId of item.children) {
        this.recursiveDeleteContextMenu(childId)
      }
    }
  }

  async deleteContextMenu(id: ContextMenuId) {
    log.debug('Deleting context menu', id, structuredClone(this.currentMenuMap))
    const item = this.currentMenuMap.get(id)
    this.recursiveDeleteContextMenu(id)
    const parentItem = this.currentMenuMap.get(item?.parentId)
    if (parentItem) {
      parentItem.children = parentItem.children.filter((childId) => childId !== id)
    }
    log.debug('Deleting context menu finished', id, structuredClone(this.currentMenuMap))
    await this.reconstructContextMenu()
  }
}
