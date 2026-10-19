import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { IVSRealTimeClient } from '@aws-sdk/client-ivs-realtime';
import { IvschatClient } from '@aws-sdk/client-ivschat';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
export function createClients(env: { AWS_REGION: string }) {
  const config = { region: env.AWS_REGION };
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient(config), { marshallOptions: { removeUndefinedValues: true } }),
    ivs: new IVSRealTimeClient(config),
    chat: new IvschatClient(config),
    s3: new S3Client(config),
    cognito: new CognitoIdentityProviderClient(config),
    ssm: new SSMClient(config),
  };
}

export type Clients = ReturnType<typeof createClients>;
