// Okta(OIDC) IdP を Cognito に登録するカスタムリソース。
// CloudFormation の ssm-secure 動的参照は Cognito IdP に使えないため、
// client secret はデプロイ時にこの Lambda が SSM SecureString から読み、テンプレートには出さない。
import {
  CognitoIdentityProviderClient,
  CreateIdentityProviderCommand,
  DeleteIdentityProviderCommand,
  UpdateIdentityProviderCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const cognito = new CognitoIdentityProviderClient({});
const ssm = new SSMClient({});

const physicalId = (props) => `${props.UserPoolId}/${props.ProviderName}`;

async function providerDetails(props) {
  const { Parameter } = await ssm.send(
    new GetParameterCommand({ Name: props.ClientSecretParameter, WithDecryption: true }),
  );
  if (!Parameter?.Value) throw new Error(`SSM パラメータが空です: ${props.ClientSecretParameter}`);
  return {
    client_id: props.ClientId,
    client_secret: Parameter.Value,
    oidc_issuer: props.Issuer,
    authorize_scopes: 'openid email profile',
    attributes_request_method: 'GET',
  };
}

export async function handler(event) {
  const props = event.ResourceProperties;
  const id = physicalId(props);
  const base = { UserPoolId: props.UserPoolId, ProviderName: props.ProviderName };

  if (event.RequestType === 'Delete') {
    try {
      await cognito.send(new DeleteIdentityProviderCommand(base));
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') throw error;
    }
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  const ProviderDetails = await providerDetails(props);
  const AttributeMapping = props.AttributeMapping;
  if (event.RequestType === 'Update' && event.PhysicalResourceId === id) {
    await cognito.send(new UpdateIdentityProviderCommand({ ...base, ProviderDetails, AttributeMapping }));
  } else {
    await cognito.send(new CreateIdentityProviderCommand({ ...base, ProviderType: 'OIDC', ProviderDetails, AttributeMapping }));
  }
  return { PhysicalResourceId: id };
}
