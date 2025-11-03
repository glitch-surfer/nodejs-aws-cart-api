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
import { Client } from 'pg';

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

        if (!username || !password) {
          log.warn('Username/password not provided; using postgres defaults');
          username = username || 'postgres';
          password = password || 'postgres';
        }

        const sslConfig = sslFlag
          ? { rejectUnauthorized: false, require: true }
          : false;

        async function tryConnectDb(dbName: string) {
          const client = new Client({
            host,
            port,
            user: username,
            password,
            database: dbName,
            ssl: sslConfig,
            connectionTimeoutMillis: 5000,
          });
          const start = Date.now();
          await client.connect();
          const dur = Date.now() - start;
          await client.end();
          return dur;
        }

        let preflightOk = false;
        try {
          log.log('Running preflight pg connectivity test to target DB...');
          const dur = await tryConnectDb(database);
          log.log(`Preflight (target DB) succeeded in ${dur}ms`);
          preflightOk = true;
        } catch (err: any) {
          const msg = err?.message || '';
          log.error('Preflight connection failed (target DB)', err as Error);
          if (autoCreate && /does not exist/i.test(msg)) {
            try {
              log.warn(
                `Database "${database}" missing; attempting auto-create`,
              );
              // Connect to default postgres db
              const client = new Client({
                host,
                port,
                user: username,
                password,
                database: 'postgres',
                ssl: sslConfig,
                connectionTimeoutMillis: 5000,
              });
              await client.connect();
              const existsRes = await client.query(
                'SELECT 1 FROM pg_database WHERE datname = $1',
                [database],
              );
              if (existsRes.rowCount === 0) {
                await client.query(`CREATE DATABASE "${database}"`);
                log.log(`Database "${database}" created`);
              } else {
                log.log(
                  `Database "${database}" already exists (race condition)`,
                );
              }
              await client.end();
              // Re-run preflight
              const dur2 = await tryConnectDb(database);
              log.log(`Preflight after create succeeded in ${dur2}ms`);
              preflightOk = true;
            } catch (createErr) {
              log.error('Auto-create database failed', createErr as Error);
            }
          }
        }

        if (!preflightOk) {
          log.warn(
            'Continuing startup even though preflight did not fully succeed (TypeORM may retry).',
          );
        }

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
