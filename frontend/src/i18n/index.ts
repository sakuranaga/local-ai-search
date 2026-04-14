import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import jaCommon from "./locales/ja/common.json";
import jaAdmin from "./locales/ja/admin.json";
import jaFileExplorer from "./locales/ja/fileExplorer.json";
import jaDocuments from "./locales/ja/documents.json";
import jaAuth from "./locales/ja/auth.json";
import jaChat from "./locales/ja/chat.json";
import jaEditor from "./locales/ja/editor.json";

import enCommon from "./locales/en/common.json";
import enAdmin from "./locales/en/admin.json";
import enFileExplorer from "./locales/en/fileExplorer.json";
import enDocuments from "./locales/en/documents.json";
import enAuth from "./locales/en/auth.json";
import enChat from "./locales/en/chat.json";
import enEditor from "./locales/en/editor.json";

const savedLocale = localStorage.getItem("las_locale") || "ja";

i18n.use(initReactI18next).init({
  resources: {
    ja: {
      common: jaCommon,
      admin: jaAdmin,
      fileExplorer: jaFileExplorer,
      documents: jaDocuments,
      auth: jaAuth,
      chat: jaChat,
      editor: jaEditor,
    },
    en: {
      common: enCommon,
      admin: enAdmin,
      fileExplorer: enFileExplorer,
      documents: enDocuments,
      auth: enAuth,
      chat: enChat,
      editor: enEditor,
    },
  },
  lng: savedLocale,
  fallbackLng: "ja",
  ns: ["common", "admin", "fileExplorer", "documents", "auth", "chat", "editor"],
  defaultNS: "common",
  interpolation: {
    escapeValue: false,
  },
});

export const t = i18n.t.bind(i18n);
export default i18n;
