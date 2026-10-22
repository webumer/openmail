export { isPrivateAddress, resolveConnectTarget, type ConnectTarget, type Resolver as AddressResolver } from "./address-guard.js";
export { BODY_CHAR_CAP, THREAD_CHAR_CAP, UNTRUSTED_CONTENT_WARNING } from "./constants.js";
export { encodeCursor, decodeCursor, type CursorPayload } from "./cursor.js";
export { normalizeDate, type NormalizedDate } from "./dates.js";
export { createImapGateway, type ImapGateway } from "./imap-gateway.js";
export {
  listAccounts,
  listFolders,
  searchMessages,
  readMessage,
  readThread,
  type AccountListItem,
  type FolderInfo,
  type MailDeps,
  type ReadMessage,
  type SearchData,
  type SearchHit,
  type SearchParams,
  type ThreadData,
  type ThreadMessage,
} from "./operations.js";
export { parseMessage, type AttachmentInfo, type MessageHeaders, type ParsedMessageContent } from "./parse-message.js";
export {
  PROVIDER_PRESETS,
  ZOHO_REGIONS,
  resolveEndpoints,
  type ImapEndpoint,
  type ProviderPreset,
  type SmtpEndpoint,
  type ZohoRegion,
} from "./presets.js";
export { ok, fail, type ToolFailure, type ToolResult, type ToolSuccess } from "./result.js";
export { hasAttachments, type BodyNode } from "./structure.js";
export { allocateText, capText, htmlToText, selectMessageText } from "./text.js";
export { buildImapConnectOptions, isAllowlistedInsecureHost, isLoopbackHost, parseInsecureImapHosts } from "./tls.js";
