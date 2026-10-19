import { AdminAddUserToGroupCommand, AdminListGroupsForUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { RoleSchema } from '@delivery/shared';
import { createClients } from './aws';
import type { Clients } from './aws';
import { getCognitoEnv, type CognitoEnv } from './env';

export interface CognitoPostAuthenticationEvent {
  userPoolId: string;
  userName: string;
  request: { userAttributes: Record<string, string> };
  response: Record<string, unknown>;
  triggerSource: string;
}

export function createCognitoPostAuthenticationHandler(dependencies?: { env?: CognitoEnv; clients?: Clients; now?: () => number }) {
  return async (event: CognitoPostAuthenticationEvent): Promise<CognitoPostAuthenticationEvent> => {
    const env = dependencies?.env ?? getCognitoEnv();
    const clients = dependencies?.clients ?? createClients(env);
    const username = event.userName;
    const attrs = event.request.userAttributes;
    const externalIdp = Boolean(attrs.identities && attrs.identities !== '[]');
    const isFirstExternalConfirmation = event.triggerSource === 'PostConfirmation_ConfirmSignUp' && externalIdp;
    const isPostAuthentication = event.triggerSource === 'PostAuthentication_Authentication';
    if (!isFirstExternalConfirmation && !isPostAuthentication) return event;
    const memberships = await clients.cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: event.userPoolId, Username: username }));
    const groups = memberships.Groups ?? [];
    if (groups.length === 0 && externalIdp) await clients.cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: event.userPoolId, Username: username, GroupName: 'viewer' }));
    else if (groups.length !== 1 || !RoleSchema.safeParse(groups[0]?.GroupName).success) throw new Error('Cognito user must belong to exactly one valid role group');
    const userId = attrs.sub;
    if (!userId) throw new Error('Cognito user sub attribute is required');
    const now = dependencies?.now?.() ?? Date.now();
    if (isPostAuthentication) await clients.ddb.send(new PutCommand({
      TableName: env.TABLE_NAME,
      Item: { PK: `USER#${userId}`, SK: 'LOGIN', lastLoginAt: new Date(now).toISOString(), loginMethod: externalIdp ? 'Okta' : 'email' },
    }));
    return event;
  };
}

export const cognitoPostAuthenticationHandler = createCognitoPostAuthenticationHandler();
export const handler = cognitoPostAuthenticationHandler;
