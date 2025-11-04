import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CartEntity, CartStatus } from '../entities/cart.entity';
import { CartItemEntity } from '../entities/cart-item.entity';
import { PutCartPayload } from 'src/order/type';

@Injectable()
export class CartService {
  constructor(
    @InjectRepository(CartEntity)
    private readonly cartRepo: Repository<CartEntity>,
    @InjectRepository(CartItemEntity)
    private readonly itemRepo: Repository<CartItemEntity>,
  ) {}

  async findByUserId(userId: string): Promise<CartEntity | null> {
    return this.cartRepo.findOne({ where: { user_id: userId } });
  }

  async createByUserId(user_id: string): Promise<CartEntity> {
    const cart = this.cartRepo.create({
      user_id,
      status: CartStatus.OPEN,
      items: [],
    });
    return this.cartRepo.save(cart);
  }

  async findOrCreateByUserId(userId: string): Promise<CartEntity> {
    const existing = await this.findByUserId(userId);
    if (existing) return existing;
    return this.createByUserId(userId);
  }

  async updateByUserId(
    userId: string,
    payload: PutCartPayload,
  ): Promise<CartEntity> {
    const cart = await this.findOrCreateByUserId(userId);
    let item = cart.items.find((i) => i.product_id === payload.product.id);
    if (!item && payload.count > 0) {
      item = this.itemRepo.create({
        cart_id: cart.id,
        cart,
        product_id: payload.product.id,
        count: payload.count,
        product: payload.product,
      });
      cart.items.push(item);
    } else if (item) {
      if (payload.count === 0) {
        cart.items = cart.items.filter((i) => i.id !== item.id);
        await this.itemRepo.remove(item);
      } else {
        item.count = payload.count;
        item.product = payload.product; // refresh snapshot
        await this.itemRepo.save(item);
      }
    }
    return this.cartRepo.save(cart);
  }

  async removeByUserId(userId: string): Promise<void> {
    const cart = await this.findByUserId(userId);
    if (cart) {
      await this.cartRepo.remove(cart);
    }
  }
}
