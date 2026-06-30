import { MigrationError } from '../../lib/errors.js'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

export interface GraphCredentials {
  tenantId: string
  clientId: string
  clientSecret: string
  /**
   * UPN (e-mail) da caixa usada como remetente do Graph Mail.Send (Application).
   * Precisa ser uma caixa real do tenant com a permissão concedida.
   */
  senderUserId: string
}

export interface GraphNotifier {
  /**
   * Envia o PIN de aprovação de gate ao responsável via Teams (1:1) + e-mail.
   * Retorna void deliberadamente — o PIN nunca volta para quem chamou esta
   * função. O único lugar onde o valor do PIN aparece é no corpo da requisição
   * HTTP de saída para a Graph API, que o agente da Squad não tem como ler.
   */
  sendGatePin(approverEmail: string, phase: number, pin: string, expiresAt: string): Promise<void>
}

async function getGraphAccessToken(creds: GraphCredentials): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    },
  )

  if (!res.ok) {
    // Mensagem de erro deliberadamente genérica — nunca inclui o PIN, mesmo
    // que esta função seja chamada a partir de sendGatePin com falha em cadeia.
    throw new MigrationError(
      'GRAPH_NOTIFICATION_FAILED',
      `Falha ao autenticar na Microsoft Graph API (status ${res.status}).`,
    )
  }

  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

async function sendTeamsMessage(
  token: string,
  recipientEmail: string,
  text: string,
): Promise<void> {
  const chatRes = await fetch(`${GRAPH_BASE}/chats`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatType: 'oneOnOne',
      members: [
        {
          '@odata.type': '#microsoft.graph.aadUserConversationMember',
          roles: ['owner'],
          'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${recipientEmail}')`,
        },
      ],
    }),
  })

  if (!chatRes.ok) {
    throw new MigrationError(
      'GRAPH_NOTIFICATION_FAILED',
      `Falha ao criar/obter chat do Teams (status ${chatRes.status}).`,
    )
  }

  const chat = (await chatRes.json()) as { id: string }

  const msgRes = await fetch(`${GRAPH_BASE}/chats/${chat.id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: { content: text } }),
  })

  if (!msgRes.ok) {
    throw new MigrationError(
      'GRAPH_NOTIFICATION_FAILED',
      `Falha ao enviar mensagem no Teams (status ${msgRes.status}).`,
    )
  }
}

async function sendEmail(
  token: string,
  senderUserId: string,
  recipientEmail: string,
  subject: string,
  text: string,
): Promise<void> {
  const res = await fetch(`${GRAPH_BASE}/users/${senderUserId}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'Text', content: text },
        toRecipients: [{ emailAddress: { address: recipientEmail } }],
      },
      saveToSentItems: false,
    }),
  })

  if (!res.ok) {
    throw new MigrationError(
      'GRAPH_NOTIFICATION_FAILED',
      `Falha ao enviar e-mail via Graph API (status ${res.status}).`,
    )
  }
}

export function createGraphNotifier(credentials: GraphCredentials): GraphNotifier {
  return {
    async sendGatePin(approverEmail, phase, pin, expiresAt): Promise<void> {
      const token = await getGraphAccessToken(credentials)
      const text =
        `PIN de aprovação — Fase ${phase} da migração JDK\n\n` +
        `Código: ${pin}\n` +
        `Expira em: ${expiresAt}\n\n` +
        'Digite este código no chat da Squad para confirmar a aprovação. ' +
        'Não compartilhe este código com sistemas automatizados.'

      await sendTeamsMessage(token, approverEmail, text)
      await sendEmail(
        token,
        credentials.senderUserId,
        approverEmail,
        `[jdk-migration] PIN de aprovação — Fase ${phase}`,
        text,
      )
    },
  }
}
