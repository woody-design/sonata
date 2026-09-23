import type { DeliveryAttachment } from "../shared/types/domain";
import { quotePathForText } from "./shell-quote";

/**
 * What a Send writes: the prompt text, with every referenced file / folder
 * folded in as a quoted path on its own line, and the image attachments that
 * the CLI turns into native chips when their paths are pasted.
 *
 * The channel split is a WRITE transform, not bookkeeping. A non-image path
 * does not chip on either CLI, so placing it in the text — quoted, on its own
 * line — is the honest wire; images keep the effect-verified paste sequence
 * (`TerminalHost.submitPrompt`). A referenced original never enters
 * `imageAttachments` unless it IS an image, and nothing here deletes anything.
 */
export function composePromptWrite(
  text: string,
  attachments: DeliveryAttachment[],
): { text: string; imageAttachments: DeliveryAttachment[] } {
  const trimmed = text.trim();
  const imageAttachments = attachments.filter(
    (attachment) => attachment.kind !== "file" && attachment.kind !== "folder",
  );
  const referencePaths = attachments
    .filter((attachment) => attachment.kind === "file" || attachment.kind === "folder")
    .map((attachment) => quotePathForText(attachment.path));
  const fullText = [trimmed, ...referencePaths].filter((part) => part.length > 0).join("\n");
  if (!fullText && imageAttachments.length === 0) {
    throw new Error("Cannot send an empty prompt without attachments.");
  }
  return { text: fullText, imageAttachments };
}
