/* eslint-disable no-param-reassign */
/* eslint-disable no-underscore-dangle */
import {
  Editor,
  MarkdownView,
  Menu,
  Notice,
  parseLinktext,
  Plugin,
  View,
} from "obsidian";
import * as CodeMirror from "codemirror";
import ImageUploader from "./uploader/ImageUploader";
// eslint-disable-next-line import/no-cycle
import ImgurPluginSettingsTab from "./ui/ImgurPluginSettingsTab";
import ApiError from "./uploader/ApiError";
import UploadStrategy from "./UploadStrategy";
import buildUploaderFrom from "./uploader/imgUploaderFactory";
import RemoteUploadConfirmationDialog from "./ui/RemoteUploadConfirmationDialog";

export interface ImgurPluginSettings {
  uploadStrategy: string;
  clientId: string;
  showRemoteUploadConfirmation: boolean;
}

const DEFAULT_SETTINGS: ImgurPluginSettings = {
  uploadStrategy: UploadStrategy.ANONYMOUS_IMGUR.id,
  clientId: null,
  showRemoteUploadConfirmation: true,
};

type Handlers = {
  drop: (cm: CodeMirror.Editor, event: DragEvent) => void;
  paste: (cm: CodeMirror.Editor, event: ClipboardEvent) => void;
};

export default class ImgurPlugin extends Plugin {
  settings: ImgurPluginSettings;

  private readonly cmAndHandlersMap = new Map<CodeMirror.Editor, Handlers>();

  private imgUploaderField: ImageUploader;

  get imgUploader(): ImageUploader {
    return this.imgUploaderField;
  }

  private async loadSettings() {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...((await this.loadData()) as ImgurPluginSettings),
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  onunload(): void {
    this.restoreOriginalHandlers();
  }

  private restoreOriginalHandlers() {
    this.cmAndHandlersMap.forEach((originalHandlers, cm) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (cm as any)._handlers.drop[0] = originalHandlers.drop;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (cm as any)._handlers.paste[0] = originalHandlers.paste;
    });
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ImgurPluginSettingsTab(this.app, this));
    this.setupImgurHandlers();
    this.setupImagesUploader();
  }

  setupImagesUploader(): void {
    this.imgUploaderField = buildUploaderFrom(this.settings);
  }

  private setupImgurHandlers() {
    this.registerCodeMirror((cm: CodeMirror.Editor) => {
      const originalHandlers = this.backupOriginalHandlers(cm);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (cm as any)._handlers.drop[0] = async (
        _: CodeMirror.Editor,
        event: DragEvent
      ) => {
        if (!this.imgUploader) {
          ImgurPlugin.showUnconfiguredPluginNotice();
          originalHandlers.drop(_, event);
          return;
        }

        if (
          event.dataTransfer.types.length !== 1 ||
          event.dataTransfer.types[0] !== "Files"
        ) {
          originalHandlers.drop(_, event);
          return;
        }

        // Preserve files before showing modal, otherwise they will be lost from the event
        const { files } = event.dataTransfer;

        if (this.settings.showRemoteUploadConfirmation) {
          const modal = new RemoteUploadConfirmationDialog(this.app);
          modal.open();

          const userResp = await modal.response();
          switch (userResp.shouldUpload) {
            case undefined:
              return;
            case true:
              if (userResp.alwaysUpload) {
                this.settings.showRemoteUploadConfirmation = false;
                this.saveSettings()
                  .then(() => {})
                  .catch(() => {});
              }
              break;
            case false: {
              // This case forces me to compose new event, the old does not have any files already
              const filesArr: Array<File> = new Array<File>(files.length);
              for (let i = 0; i < filesArr.length; i += 1) {
                filesArr[i] = files[i];
              }
              originalHandlers.drop(
                _,
                ImgurPlugin.composeNewDragEvent(event, filesArr)
              );
              return;
            }
            default:
              return;
          }
        }

        for (let i = 0; i < files.length; i += 1) {
          if (!files[i].type.startsWith("image")) {
            // using original handlers if at least one of drag-and drop files is not an image
            // It is not possible to call DragEvent.dataTransfer#clearData(images) here
            // to split images and non-images processing
            originalHandlers.drop(_, event);
            return;
          }
        }

        // Adding newline to avoid messing images pasted via default handler
        // with any text added by the plugin
        this.getEditor().replaceSelection("\n");

        const promises: Promise<void>[] = [];
        const filesFailedToUpload: File[] = [];
        for (let i = 0; i < files.length; i += 1) {
          const image = files[i];
          const uploadPromise = this.uploadFileAndEmbedImgurImage(image).catch(
            () => {
              filesFailedToUpload.push(image);
            }
          );
          promises.push(uploadPromise);
        }

        await Promise.all(promises);

        if (filesFailedToUpload.length === 0) return;

        const newEvt = ImgurPlugin.composeNewDragEvent(
          event,
          filesFailedToUpload
        );
        originalHandlers.drop(_, newEvt);
      };

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (cm as any)._handlers.paste[0] = async (
        _: CodeMirror.Editor,
        e: ClipboardEvent
      ) => {
        if (!this.imgUploader) {
          ImgurPlugin.showUnconfiguredPluginNotice();
          originalHandlers.paste(_, e);
          return;
        }

        const { files } = e.clipboardData;
        if (files.length === 0 || !files[0].type.startsWith("image")) {
          originalHandlers.paste(_, e);
          return;
        }

        if (this.settings.showRemoteUploadConfirmation) {
          const modal = new RemoteUploadConfirmationDialog(this.app);
          modal.open();

          const userResp = await modal.response();
          switch (userResp.shouldUpload) {
            case undefined:
              return;
            case true:
              if (userResp.alwaysUpload) {
                this.settings.showRemoteUploadConfirmation = false;
                this.saveSettings()
                  .then(() => {})
                  .catch(() => {});
              }
              break;
            case false:
              originalHandlers.paste(_, e);
              return;
            default:
              return;
          }
        }

        for (let i = 0; i < files.length; i += 1) {
          this.uploadFileAndEmbedImgurImage(files[i]).catch(() => {
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(files[i]);
            const newEvt = new ClipboardEvent("paste", {
              clipboardData: dataTransfer,
            });
            originalHandlers.paste(_, newEvt);
          });
        }
      };
    });

    this.registerEvent(
      this.app.workspace.on(
        "editor-menu",
        (menu: Menu, editor: Editor, view: MarkdownView) => {
          menu.addItem((item) => {
            item
              .setTitle("Upload to Imgur")
              .setIcon("wand")
              .onClick(async () => {
                const clickable = editor.getClickableTokenAt(
                  editor.getCursor()
                );

                const lt = parseLinktext(clickable.text);
                const file = this.app.metadataCache.getFirstLinkpathDest(
                  lt.path,
                  view.file.path
                );

                const arrayBuffer = await this.app.vault.readBinary(file);

                const fileToUpload = new File([arrayBuffer], file.name);

                // console.log(blob);

                this.uploadFileAndEmbedImgurImage(fileToUpload)
                  .then(() => view.app.vault.trash(file, true))
                  .catch((ee) => console.log(ee));

                // console.log(file);
                // console.log(this.app.metadataCache.getFileCache(file.path));

                // this.app.vault
                //   .trash(file, true)
                //   .then(() => {})
                //   .catch(() => {});
              });
          });
        }
      )
    );
  }

  private static composeNewDragEvent(
    originalEvent: DragEvent,
    failedUploads: File[]
  ) {
    const dataTransfer = failedUploads.reduce((dt, fileFailedToUpload) => {
      dt.items.add(fileFailedToUpload);
      return dt;
    }, new DataTransfer());

    return new DragEvent(originalEvent.type, {
      dataTransfer,
      clientX: originalEvent.clientX,
      clientY: originalEvent.clientY,
    });
  }

  private static showUnconfiguredPluginNotice() {
    const fiveSecondsMillis = 5_000;
    // eslint-disable-next-line no-new
    new Notice(
      "⚠️ Please configure Imgur plugin or disable it",
      fiveSecondsMillis
    );
  }

  private backupOriginalHandlers(cm: CodeMirror.Editor) {
    if (!this.cmAndHandlersMap.has(cm)) {
      this.cmAndHandlersMap.set(cm, {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        drop: (cm as any)._handlers.drop[0],
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        paste: (cm as any)._handlers.paste[0],
      });
    }

    return this.cmAndHandlersMap.get(cm);
  }

  private async uploadFileAndEmbedImgurImage(file: File) {
    const pasteId = (Math.random() + 1).toString(36).substr(2, 5);
    this.insertTemporaryText(pasteId);

    let imgUrl: string;
    try {
      imgUrl = await this.imgUploaderField.upload(file);
    } catch (e) {
      if (e instanceof ApiError) {
        this.handleFailedUpload(
          pasteId,
          `Upload failed, remote server returned an error: ${e.message}`
        );
      } else {
        // eslint-disable-next-line no-console
        console.error("Failed imgur request: ", e);
        this.handleFailedUpload(
          pasteId,
          "⚠️Imgur upload failed, check dev console"
        );
      }
      throw e;
    }
    this.embedMarkDownImage(pasteId, imgUrl);
  }

  private insertTemporaryText(pasteId: string) {
    const progressText = ImgurPlugin.progressTextFor(pasteId);
    this.getEditor().replaceSelection(`${progressText}\n`);
  }

  private static progressTextFor(id: string) {
    return `![Uploading file...${id}]()`;
  }

  private embedMarkDownImage(pasteId: string, imageUrl: string) {
    const progressText = ImgurPlugin.progressTextFor(pasteId);
    const markDownImage = `![](${imageUrl})`;

    ImgurPlugin.replaceFirstOccurrence(
      this.getEditor(),
      progressText,
      markDownImage
    );
  }

  private handleFailedUpload(pasteId: string, message: string) {
    const progressText = ImgurPlugin.progressTextFor(pasteId);
    ImgurPlugin.replaceFirstOccurrence(
      this.getEditor(),
      progressText,
      `<!--${message}-->`
    );
  }

  private getEditor(): Editor {
    const mdView = this.app.workspace.activeLeaf.view as MarkdownView;
    return mdView.editor;
  }

  private static replaceFirstOccurrence(
    editor: Editor,
    target: string,
    replacement: string
  ) {
    const lines = editor.getValue().split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const ch = lines[i].indexOf(target);
      if (ch !== -1) {
        const from = { line: i, ch };
        const to = { line: i, ch: ch + target.length };
        editor.replaceRange(replacement, from, to);
        break;
      }
    }
  }
}
