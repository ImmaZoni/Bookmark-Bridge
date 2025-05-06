declare module 'obsidian' {
    export class Plugin {
        app: App;
        manifest: PluginManifest;
        addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement;
        addCommand(command: Command): void;
        addSettingTab(settingTab: PluginSettingTab): void;
        saveData(data: any): Promise<void>;
        loadData(): Promise<any>;
    }

    export interface Command {
        id: string;
        name: string;
        callback?: () => any;
        hotkeys?: Hotkey[];
        editorCallback?: (editor: Editor, view: MarkdownView) => any;
        editorCheckCallback?: (checking: boolean, editor: Editor, view: MarkdownView) => any | boolean;
    }

    export class PluginSettingTab {
        constructor(app: App, plugin: Plugin);
        containerEl: HTMLElement;
        display(): void;
    }

    export class App {
        vault: Vault;
    }

    export interface Vault {
        adapter: DataAdapter;
        createFolder(path: string): Promise<void>;
        getAbstractFileByPath(path: string): TAbstractFile | null;
        create(path: string, data: string): Promise<TFile>;
        modify(file: TFile, data: string): Promise<void>;
    }

    export interface DataAdapter {
        exists(path: string): Promise<boolean>;
        read(path: string): Promise<string>;
        write(path: string, data: string): Promise<void>;
    }

    export abstract class TAbstractFile {
        path: string;
    }

    export class TFile extends TAbstractFile {
        
    }

    export class TFolder extends TAbstractFile {
        
    }

    export class Setting {
        constructor(containerEl: HTMLElement);
        setName(name: string): Setting;
        setDesc(desc: string): Setting;
        addText(cb: (text: TextComponent) => any): Setting;
        addButton(cb: (button: ButtonComponent) => any): Setting;
        addDropdown(cb: (dropdown: DropdownComponent) => any): Setting;
        addToggle(cb: (toggle: ToggleComponent) => any): Setting;
        addTextArea(cb: (textArea: TextAreaComponent) => any): Setting;
    }

    export class TextComponent {
        inputEl: HTMLInputElement;
        setPlaceholder(placeholder: string): TextComponent;
        setValue(value: string): TextComponent;
        getValue(): string;
        onChange(callback: (value: string) => any): TextComponent;
    }

    export class TextAreaComponent {
        inputEl: HTMLTextAreaElement;
        setPlaceholder(placeholder: string): TextAreaComponent;
        setValue(value: string): TextAreaComponent;
        getValue(): string;
        onChange(callback: (value: string) => any): TextAreaComponent;
    }

    export class ToggleComponent {
        setValue(value: boolean): ToggleComponent;
        getValue(): boolean;
        onChange(callback: (value: boolean) => any): ToggleComponent;
    }

    export class ButtonComponent {
        setButtonText(text: string): ButtonComponent;
        onClick(callback: () => any): ButtonComponent;
    }

    export class DropdownComponent {
        addOption(value: string, display: string): DropdownComponent;
        setValue(value: string): DropdownComponent;
        getValue(): string;
        onChange(callback: (value: string) => any): DropdownComponent;
    }

    export class Notice {
        constructor(message: string, timeout?: number);
        setMessage(message: string): void;
        hide(): void;
    }

    export function normalizePath(path: string): string;

    export interface PluginManifest {
        id: string;
        name: string;
        version: string;
        minAppVersion: string;
        description: string;
        author: string;
        authorUrl: string;
        isDesktopOnly: boolean;
    }

    export interface Hotkey {
        modifiers: string[];
        key: string;
    }

    export interface Editor {
        getSelection(): string;
    }

    export interface MarkdownView {
        editor: Editor;
    }
    
    // Extend HTMLElement with Obsidian-specific methods
    export interface HTMLElement {
        addClass(className: string): this;
        removeClass(className: string): this;
        toggleClass(className: string, value?: boolean): this;
        empty(): this;
        createEl<K extends keyof HTMLElementTagNameMap>(
            tag: K,
            attrs?: { [attr: string]: string | number | boolean },
            content?: string | DocumentFragment | HTMLElement
        ): HTMLElementTagNameMap[K];
        createDiv(
            attrs?: { [attr: string]: string | number | boolean },
            content?: string | DocumentFragment | HTMLElement
        ): HTMLDivElement;
        createSpan(
            attrs?: { [attr: string]: string | number | boolean },
            content?: string | DocumentFragment | HTMLElement
        ): HTMLSpanElement;
    }
} 