import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { aws_secretsmanager as secretsmanager } from 'aws-cdk-lib';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { join } from 'path';

export class LibStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);


    // Use existing default VPC (simplifies setup vs defining subnets). Requires env account/region.
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // Secret for DB credentials (username fixed, password generated)
    const dbCredentialsSecret = new secretsmanager.Secret(this, 'MyDbCreds', {
      secretName: 'MySimplePostgresCreds',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'myadminuser' }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });

    // Simple public Postgres instance (demo only; not for production)
    const dbInstance = new rds.DatabaseInstance(this, 'PostgresInstance', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE3,
        ec2.InstanceSize.MICRO,
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      credentials: rds.Credentials.fromSecret(dbCredentialsSecret),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      multiAz: false,
      allowMajorVersionUpgrade: false,
      autoMinorVersionUpgrade: true,
      backupRetention: cdk.Duration.days(7),
      deleteAutomatedBackups: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Dev/demo only
      deletionProtection: false,
      publiclyAccessible: true,
    });

    // Lambda function that could connect to the DB (NestJS lambda entry). Timeout bumped to 30s.
    const lambdaFunction = new lambdaNodejs.NodejsFunction(this, 'AppLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: join(__dirname, '../../src', 'main-lambda.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      vpc,
      allowPublicSubnet: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      bundling: {
        externalModules: [
          'aws-sdk',
          '@nestjs/microservices',
          '@nestjs/websockets/socket-module',
        ],
        keepNames: true,
        minify: false,
      },
      environment: {
        DB_HOST: dbInstance.instanceEndpoint.hostname,
        DB_PORT: dbInstance.instanceEndpoint.port.toString(),
        DB_SECRET_ARN: dbCredentialsSecret.secretArn,
        DB_NAME: 'appdb',
        DB_ENGINE: 'postgres',
        DB_USERNAME: dbCredentialsSecret
          .secretValueFromJson('username')
          .unsafeUnwrap()
          .toString(),
        DB_PASSWORD: dbCredentialsSecret
          .secretValueFromJson('password')
          .unsafeUnwrap()
          .toString(),
        DB_SSL: 'true',
        DB_AUTO_CREATE: 'true',
      },
    });

    // Connectivity & secret access
    dbInstance.connections.allowDefaultPortFrom(
      lambdaFunction,
      'Allow Lambda to access Postgres default port',
    );
    dbCredentialsSecret.grantRead(lambdaFunction);

    const functionUrl = lambdaFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        // Allow all methods, origins, and headers for simplicity.
        // In a real-world application, you should restrict these.
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'DbEndpoint', {
      value: dbInstance.instanceEndpoint.socketAddress,
    });
    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: dbCredentialsSecret.secretArn,
    });
    new cdk.CfnOutput(this, 'LambdaUrl', {
      value: functionUrl.url,
    });
  }
}
