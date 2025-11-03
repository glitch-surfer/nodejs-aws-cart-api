import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-infra/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { aws_apigateway as apigateway } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { join } from 'path';

export class LibStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with public subnet (Lambda) and isolated private subnet (RDS)
    const vpc = new ec2.Vpc(this, 'AppVpc', {
      maxAzs: 2,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: 'Db',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Security Groups
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
    });
    const dbSg = new ec2.SecurityGroup(this, 'DbSecurityGroup', { vpc });
    dbSg.addIngressRule(
      lambdaSg,
      ec2.Port.tcp(5432),
      'Allow Lambda access to Postgres',
    );

    // Secret for DB credentials
    const dbCredentialsSecret = new secretsmanager.Secret(
      this,
      'PostgresCreds',
      {
        secretName: 'PostgresDbCredentials',
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: 'postgresadmin' }),
          generateStringKey: 'password',
          excludePunctuation: true,
        },
      },
    );

    // RDS PostgreSQL Instance
    const dbInstance = new rds.DatabaseInstance(this, 'PostgresInstance', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_4,
      }),
      credentials: rds.Credentials.fromSecret(dbCredentialsSecret),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE3,
        ec2.InstanceSize.MICRO,
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      multiAz: false,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      publiclyAccessible: false,
      securityGroups: [dbSg],
      backupRetention: cdk.Duration.days(3),
      autoMinorVersionUpgrade: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Dev only; do not use in prod
      deletionProtection: false,
    });

    // Lambda (NestJS) inside VPC (public subnet) with environment variables for DB
    const nestLambda = new lambdaNodejs.NodejsFunction(this, 'NestLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: join(__dirname, '../../src', 'main-lambda.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      vpc,
      securityGroups: [lambdaSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      allowPublicSubnet: true,
      environment: {
        DB_HOST: dbInstance.instanceEndpoint.hostname,
        DB_PORT: dbInstance.instanceEndpoint.port.toString(),
        DB_SECRET_ARN: dbCredentialsSecret.secretArn,
        DB_NAME: 'appdb',
        DB_ENGINE: 'postgres',
        DB_SSL: 'true',
        DB_USERNAME: dbCredentialsSecret
          .secretValueFromJson('username')
          .unsafeUnwrap()
          .toString(),
        DB_PASSWORD: dbCredentialsSecret
          .secretValueFromJson('password')
          .unsafeUnwrap()
          .toString(),
      },
      bundling: {
        externalModules: [
          'aws-sdk',
          '@nestjs/websockets',
          '@nestjs/microservices',
        ],
        keepNames: true,
        minify: false,
      },
    });

    // Grant Lambda permission to read secret & allow DB port access (redundant with SG but explicit)
    dbCredentialsSecret.grantRead(nestLambda);
    dbInstance.connections.allowDefaultPortFrom(
      nestLambda,
      'Lambda access to Postgres',
    );

    // API Gateway fronting Lambda
    const api = new apigateway.RestApi(this, 'NestApi', {
      restApiName: 'Nest Service',
      description: 'This service serves a Nest.js application.',
    });

    const lambdaIntegration = new apigateway.LambdaIntegration(nestLambda);
    api.root.addMethod('ANY', lambdaIntegration);
    const proxy = api.root.addResource('{proxy+}');
    proxy.addMethod('ANY', lambdaIntegration);

    // Outputs
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.url ?? 'API URL not available',
    });
    new cdk.CfnOutput(this, 'DbEndpoint', {
      value: dbInstance.instanceEndpoint.socketAddress,
    });
    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: dbCredentialsSecret.secretArn,
    });
  }
}
