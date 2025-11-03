import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { CartModule } from './cart/cart.module';
import { AuthModule } from './auth/auth.module';
import { OrderModule } from './order/order.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CartEntity } from './cart/entities/cart.entity';
import { CartItemEntity } from './cart/entities/cart-item.entity';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

const log = new Logger('DBInit');

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    CartModule,
    OrderModule,
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const host = config.get<string>('DB_HOST');
        const port = parseInt(config.get<string>('DB_PORT') || '5432', 10);
        const database = config.get<string>('DB_NAME');
        let username = config.get<string>('DB_USERNAME');
        let password = config.get<string>('DB_PASSWORD');
        const secretArn = config.get<string>('DB_SECRET_ARN');
        const sslFlag = config.get<string>('DB_SSL') === 'true';
        const autoCreate =
          (config.get<string>('DB_AUTO_CREATE') || 'true') === 'true';

        log.log(
          `Starting DB config host=${host} port=${port} db=${database} ssl=${sslFlag} autoCreate=${autoCreate} secretArn=${secretArn || 'none'}`,
        );

        if (secretArn && (!username || !password)) {
          try {
            log.log('Fetching credentials from Secrets Manager');
            const clientSm = new SecretsManagerClient({});
            const secret = await clientSm.send(
              new GetSecretValueCommand({ SecretId: secretArn }),
            );
            if (secret.SecretString) {
              const parsed = JSON.parse(secret.SecretString);
              username = username || parsed.username;
              password = password || parsed.password || parsed.secret;
              log.log('Secret credentials loaded');
            } else {
              log.warn('Secret missing SecretString field');
            }
          } catch (e) {
            log.error('Secrets fetch failed', e as Error);
          }
        }

        const sslConfig = sslFlag
          ? { rejectUnauthorized: false, require: true }
          : false;

        const ormConfig = {
          type: 'postgres',
          host,
          port,
          username,
          password,
          database,
          entities: [CartEntity, CartItemEntity],
          synchronize: true, // DEV ONLY
          ssl: sslConfig,
          logging: ['error'],
          extra: { connectionTimeoutMillis: 5000 },
          retryAttempts: 2,
          retryDelay: 1000,
        } as any;

        log.log('TypeORM config prepared, returning to Nest');
        return ormConfig;
      },
    }),
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
