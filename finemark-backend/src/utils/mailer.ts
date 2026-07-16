import { ConfidentialClientApplication } from "@azure/msal-node";
import { Client } from "@microsoft/microsoft-graph-client";
import "isomorphic-fetch";

const TENANT_ID = process.env.GRAPH_TENANT_ID!;
const CLIENT_ID = process.env.GRAPH_CLIENT_ID!;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET!;
const SENDER_MAILBOX =
  process.env.GRAPH_CUSTOMER_MAILBOX || "customer@finemarktracking.co.ke";

let _msalApp: ConfidentialClientApplication | null = null;

const getMsalApp = (): ConfidentialClientApplication => {
  if (!_msalApp) {
    _msalApp = new ConfidentialClientApplication({
      auth: {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        authority: `https://login.microsoftonline.com/${TENANT_ID}`,
      },
    });
  }
  return _msalApp;
};

const getGraphClient = async (): Promise<Client> => {
  const result = await getMsalApp().acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });
  if (!result?.accessToken) {
    throw new Error("Failed to acquire MS Graph access token.");
  }
  return Client.init({
    authProvider: (done) => done(null, result.accessToken),
  });
};

export const sendMail = async (options: {
  to: string;
  from?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
}) => {
  const client = await getGraphClient();

  const message: Record<string, unknown> = {
    subject: options.subject,
    body: {
      contentType: options.html ? "HTML" : "Text",
      content: options.html || options.text || "",
    },
    toRecipients: [{ emailAddress: { address: options.to } }],
  };

  if (options.attachments?.length) {
    message.attachments = options.attachments.map((att) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: att.filename,
      contentType: att.contentType || "application/octet-stream",
      contentBytes: att.content.toString("base64"),
    }));
  }

  await client
    .api(`/users/${SENDER_MAILBOX}/sendMail`)
    .post({ message, saveToSentItems: true });
};
