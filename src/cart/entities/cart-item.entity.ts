import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CartEntity } from './cart.entity';

@Entity({ name: 'cart_items' })
@Index(['cart_id', 'product_id'], { unique: true })
export class CartItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  cart_id: string;

  @Column({ type: 'varchar' })
  product_id: string;

  @Column({ type: 'int', default: 0 })
  count: number;

  @Column({ type: 'jsonb', nullable: true })
  product: any; // stored product snapshot

  @ManyToOne(() => CartEntity, (cart) => cart.items, { onDelete: 'CASCADE' })
  cart: CartEntity;
}
