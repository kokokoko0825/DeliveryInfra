import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { AdminAddUserToGroupCommand, AdminListGroupsForUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { createClients } from './aws';
import { CognitoEnvSchema } from './env';
import { createCognitoPostAuthenticationHandler } from './cognito';

const env = CognitoEnvSchema.parse({TABLE_NAME: 'table'});
const clients = createClients(env);
const cognito = mockClient(clients.cognito);
const ddb = mockClient(clients.ddb);
const cognitoPostAuthenticationHandler = createCognitoPostAuthenticationHandler({ env, clients, now: () => 1_700_000_000_000 });

beforeEach(() => { cognito.reset(); ddb.reset(); cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [] }); cognito.on(AdminAddUserToGroupCommand).resolves({}); ddb.on(PutCommand).resolves({}); });

describe('post authentication hook', () => {
  it('adds viewer during first external confirmation', async () => {
    const event = { userPoolId: 'pool', userName: 'user', request: { userAttributes: { sub: 'sub', identities: '[{"providerName":"Okta"}]' } }, response: {}, triggerSource: 'PostConfirmation_ConfirmSignUp' };
    await expect(cognitoPostAuthenticationHandler(event)).resolves.toBe(event);
    expect(cognito.commandCalls(AdminAddUserToGroupCommand)[0]?.args[0].input.GroupName).toBe('viewer');
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
  it('records last login for an existing role member', async () => {
    cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: 'viewer' }] });
    const event = { userPoolId: 'pool', userName: 'user', request: { userAttributes: { sub: 'sub' } }, response: {}, triggerSource: 'PostAuthentication_Authentication' };
    await cognitoPostAuthenticationHandler(event);
    expect(ddb.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({ PK: 'USER#sub', SK: 'LOGIN', loginMethod: 'email' });
  });
  it('rejects users without a role after the first external login case', async () => {
    const event = { userPoolId: 'pool', userName: 'user', request: { userAttributes: { sub: 'sub' } }, response: {}, triggerSource: 'PostAuthentication_Authentication' };
    await expect(cognitoPostAuthenticationHandler(event)).rejects.toThrow('exactly one valid role group');
  });
});
