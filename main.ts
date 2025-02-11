import {
  App,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownView,
  setIcon,
  type TFile, WorkspaceLeaf, WorkspaceTabs,
} from 'obsidian'

type SplitDirectionSetting = 'vertical' | 'horizontal' | 'auto'
type PaneTypeSetting = 'source' | 'preview'

interface AutoSplitSettings {
  autoSplit: boolean
  minSize: number
  direction: SplitDirectionSetting
  editorFirst: boolean
  paneToFocus: PaneTypeSetting
  linkPanes: boolean
}

const DEFAULT_SETTINGS: AutoSplitSettings = {
  autoSplit: true,
  minSize: 1000,
  direction: 'auto',
  editorFirst: true,
  paneToFocus: 'source',
  linkPanes: true,
}

export default class AutoSplitPlugin extends Plugin {
  settings!: AutoSplitSettings

  protected hasOpenFiles = false
  protected updateHasOpenFiles() {
    try {
      this.hasOpenFiles =
        this.app.workspace.getLeavesOfType('markdown').length > 0
    } catch (e) {
      // it's okay to fail sometimes
    }
  }

  async onload() {
    await this.loadSettings()

    this.addSettingTab(new AutoSplitSettingTab(this.app, this))

    this.addCommand({
      id: 'split-current-pane',
      name: 'Split and link current pane',
      checkCallback: (checking) => {
        if (Platform.isPhone) return false
        const file = this.app.workspace.activeEditor?.file
        if (!file) return false
        if (!checking) this.splitActiveFile(file)
        return true
      },
    })

    this.app.workspace.onLayoutReady(() => {
      this.updateHasOpenFiles()

      this.registerEvent(
        this.app.workspace.on('file-open', async (file) => {
          if (
            this.settings.autoSplit &&
            !Platform.isPhone &&
            this.app.workspace.getLeavesOfType('markdown').length === 1 &&
            !this.hasOpenFiles &&
            file
          ) {
            await this.splitActiveFile(file, true)
          }

          this.updateHasOpenFiles()
        })
      )
    })
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }

  /**
   * 查找当前工作区里最右侧的 Pane（WorkspaceTabs），然后返回其中的 Leaf
   */
  private findRightPaneLeaf(): WorkspaceLeaf | null {
    let rightmostTabs: WorkspaceTabs | null = null;
    let rightmostLeaf: WorkspaceLeaf | null = null;

    // 遍历所有 leaf
    this.app.workspace.iterateAllLeaves((leaf) => {
      const parentTabs = leaf.parent;
      // 只考虑 WorkspaceTabs 类型
      if (!(parentTabs instanceof WorkspaceTabs)) return;

      // container 的类型是 WorkspaceSplit，但其类型声明中没有 children 属性，
      // 因此需要通过类型断言访问 children
      const container = parentTabs.parent;
      if (container && (container as any).children && (container as any).children.length > 1) {
        const children = (container as any).children;
        // 如果当前的 WorkspaceTabs 是 container 的最后一个子项，则认为它位于右侧
        if (children[children.length - 1] === parentTabs) {
          rightmostTabs = parentTabs;
        }
      }
    });

    if (rightmostTabs) {
      // 返回 rightmostTabs 中最后一个 leaf
      rightmostLeaf = (rightmostTabs as any).children[(rightmostTabs as any).children.length - 1] as WorkspaceLeaf;
    }

    return rightmostLeaf;
  }

  async splitActiveFile(file: TFile, autoSplit = false) {
    const activeLeaf =
      this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf
    if (!activeLeaf) return

    const rootSize = getRootContainerSize(this.app)
    let direction = this.settings.direction
    if (direction === 'auto') {
      direction = rootSize.width >= rootSize.height ? 'vertical' : 'horizontal'
    }

    // ★ 如果是 vertical 模式，则先检查是否已经存在右侧 Pane 组
    if (direction === 'vertical') {
      const rightLeaf = this.findRightPaneLeaf();  // 新增：查找已有的右侧 Pane
      if (rightLeaf) {
        // 如果找到了，就直接在右侧 Pane 中新建（以预览模式打开）
        const viewState = activeLeaf.getViewState();
        if (viewState.type !== 'markdown') return;

        // 切换状态为预览模式（这里将 active 设为 false）
        const newState = {
          ...viewState,
          active: false,
          state: { ...viewState.state, mode: 'preview' },
        };

        await rightLeaf.openFile(file, newState);

        // 如果需要链接 Pane，则把当前的 activeLeaf 与 rightLeaf 设为一组
        if (this.settings.linkPanes) {
          activeLeaf.setGroupMember(rightLeaf);
        }

        // 如果自动拆分且设置要求焦点在预览 Pane，则设置焦点
        // @ts-ignore
        if (autoSplit && viewState.state.mode === this.settings.paneToFocus) {
          this.app.workspace.setActiveLeaf(rightLeaf, { focus: true });
        }
        // 找到右侧 Pane 后，不再新建 Pane，直接返回
        return;
      }
    }
    // ★ 如果没有找到（或不是 vertical 模式），则执行原有的新拆分逻辑

    if (
      (direction === 'vertical' ? rootSize.width : rootSize.height) >
      this.settings.minSize
    ) {
      const viewState = activeLeaf.getViewState()

      if (viewState.type !== 'markdown') return

      const state = viewState.state as any;

      viewState.active = false
      state.mode = state.mode === 'preview' ? 'source' : 'preview'

      const firstPane = this.settings.editorFirst ? 'source' : 'preview'

      const newLeaf = this.app.workspace.createLeafBySplit(
        activeLeaf,
        direction,
        autoSplit && state.mode === firstPane
      )
      await newLeaf.openFile(file, viewState)

      if (!autoSplit || this.settings.linkPanes) {
        activeLeaf.setGroupMember(newLeaf)
      }

      if (autoSplit && state.mode === this.settings.paneToFocus) {
        this.app.workspace.setActiveLeaf(newLeaf, { focus: true })
      }
    }
  }
}

class AutoSplitSettingTab extends PluginSettingTab {
  plugin: AutoSplitPlugin

  constructor(app: App, plugin: AutoSplitPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    let { containerEl } = this

    containerEl.empty()

    if (Platform.isPhone) {
      const infoText = containerEl.createEl('div', {
        cls: 'auto-split-settings-info-text',
      })
      setIcon(infoText, 'info')
      infoText.createEl('p', {
        text: 'Split panes are not supported on phones.',
      })
      return
    }

    containerEl.createEl('h2', { text: 'Auto Split Settings' })

    new Setting(containerEl)
      .setName('Split Automatically')
      .setDesc(
        'Turn off to only split when the command "Split and link current pane" is used.'
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoSplit)
          .onChange(async (value) => {
            this.plugin.settings.autoSplit = value
            await this.plugin.saveSettings()
          })
      })

    const { width: rootWidth, height: rootHeight } = getRootContainerSize(
      this.app
    )

    new Setting(containerEl)
      .setName('Minimum Size')
      .setDesc(
        `Only split if the main area is at least this wide or tall, depending on split direction. The main area was ${rootWidth}x${rootHeight} when you opened this screen. (default: 1000)`
      )
      .addText((text) => {
        text.inputEl.type = 'number'
        text
          .setValue(String(this.plugin.settings.minSize))
          .onChange(async (value) => {
            const valueAsNumber = Number.parseInt(value)
            this.plugin.settings.minSize = Number.isInteger(valueAsNumber)
              ? valueAsNumber
              : this.plugin.settings.minSize
            await this.plugin.saveSettings()
          })
      })

    new Setting(containerEl)
      .setName('Split Direction')
      .setDesc(
        'Vertical = left/right, Horizontal = up/down. Auto splits vertically if the main area is wider than it is tall, and horizontally otherwise.'
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOptions({
            auto: 'Auto',
            vertical: 'Vertical',
            horizontal: 'Horizontal',
          })
          .setValue(this.plugin.settings.direction)
          .onChange(async (value) => {
            this.plugin.settings.direction = value as SplitDirectionSetting
            await this.plugin.saveSettings()
          })
      })

    const infoText = containerEl.createEl('div', {
      cls: 'auto-split-settings-info-text',
    })
    setIcon(infoText, 'info')
    infoText.createEl('p', {
      text: 'Settings below do not apply to the "Split and link current pane" command.',
    })

    new Setting(containerEl)
      .setName('Editor First')
      .setDesc('Place the pane with the editor on the left/top.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.editorFirst)
          .onChange(async (value) => {
            this.plugin.settings.editorFirst = value
            await this.plugin.saveSettings()
          })
      })

    new Setting(containerEl)
      .setName('Focus On')
      .setDesc('Select which pane should be focused.')
      .addDropdown((dropdown) => {
        dropdown
          .addOptions({
            source: 'Editor',
            preview: 'Preview',
          })
          .setValue(this.plugin.settings.paneToFocus)
          .onChange(async (value) => {
            this.plugin.settings.paneToFocus = value as PaneTypeSetting
            await this.plugin.saveSettings()
          })
      })

    new Setting(containerEl)
      .setName('Link Panes')
      .setDesc(
        'Link the panes so their scroll position and open file stay the same.'
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.linkPanes)
          .onChange(async (value) => {
            this.plugin.settings.linkPanes = value
            await this.plugin.saveSettings()
          })
      })
  }
}

function getRootContainerSize(app: App) {
  const rootContainer: HTMLElement = app.workspace.rootSplit.doc.documentElement

  if (rootContainer) {
    return {
      width: rootContainer.clientWidth,
      height: rootContainer.clientHeight,
    }
  } else {
    console.warn(`[Auto Split] couldn't get root container, using window size`)
    return {
      width: window.innerWidth,
      height: window.innerHeight,
    }
  }
}
