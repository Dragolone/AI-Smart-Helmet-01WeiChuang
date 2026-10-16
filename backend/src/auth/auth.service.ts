import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { isUniqueViolation } from '../common/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { SmsCodeService, type SmsCodePurpose } from './sms-code.service';

/** API.md §2 定稿：access 15 分钟 / refresh 30 天（轮换制） */
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 刷新应答丢失的补发窗口（评审 R-05 / 10-06 并发评审 #2）：App 的刷新请求到了服务端、应答却没回去
 * （隧道里被 RST、切网、或等满 15 s 超时），它手里还是旧 token，下一次刷新带的仍是旧 token——
 * 连接被重置时这「下一次」可能就在一两秒内。旧 token 在本窗口内再次出现，当作「上次的应答没送到」：
 * 作废那张从没用过的新 token、再发一张；每张旧 token 只补发一次。超过本窗口再出现才按盗用撤销全部会话。
 * 取 access 的寿命，断网几分钟后回来的第一次刷新落在窗口内。
 */
const REFRESH_RETRY_WINDOW_MS = 15 * 60 * 1000;
/**
 * 同一 token 真正并发的刷新（同一瞬间到达，相差几十毫秒）：输家只拒绝本次，赢家的新 token 不受影响。
 * 原先这个窗口是 10 s——但 App 对刷新做了单飞，同一台手机不会真的并发两次；应答被连接重置吞掉后
 * App 一两秒内就会带旧 token 重试，10 s 一律拒绝等于让骑手在隧道里被动登出（10-06 并发评审 #2）。
 * 缩到半秒：并发竞态仍能挡住（同一 token 并发 ×8 恰好一个成功），一秒后的重试走补发。
 */
const REFRESH_CONCURRENT_GRACE_MS = 500;
const BCRYPT_ROUNDS = 10;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface SafeUser {
  id: string;
  phone: string;
  nickname: string | null;
  avatarUrl: string | null;
  createdAt: Date;
}

const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

const unauthorized = (message: string): UnauthorizedException =>
  new UnauthorizedException({ code: 'UNAUTHORIZED', message });

const phoneTaken = (): ConflictException =>
  new ConflictException({
    code: 'PHONE_ALREADY_REGISTERED',
    message: '该手机号已注册',
  });

/** 沿 refresh token 替代链走的最大跳数（防脏数据成环） */
const MAX_REPLACEMENT_HOPS = 10;

/**
 * 轮换 / 补发事务的第一句：给用户行加共享锁，与改密 / 重置 / 注销（它们的事务第一句都是更新用户行）串行。
 * 不锁的话 READ COMMITTED 下并发的 refresh 刚插入的新 token 改密那句 updateMany 看不见，改密后照样能用（10-17 评审 R1-3）。
 * 用 FOR SHARE 而不是 FOR KEY SHARE：后者与 user.update 的 NO KEY UPDATE 锁不冲突
 */
const lockUserRow = (
  tx: Pick<PrismaService, '$queryRaw'>,
  userId: string,
): Promise<unknown> =>
  tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId} FOR SHARE`;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly smsCodes: SmsCodeService,
  ) {}

  /**
   * 下发验证码前按用途校验手机号状态：注册/换绑用途拒绝已注册号（不给已注册号发码，也让前端提前提示去登录）；
   * 找回密码用途要求已注册。都会暴露"该号是否注册"，与 register 的 409 口径一致，MVP 接受。
   */
  async sendSmsCode(phone: string, purpose: SmsCodePurpose): Promise<void> {
    const existing = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });
    if ((purpose === 'register' || purpose === 'change_phone') && existing) {
      throw phoneTaken();
    }
    if (purpose === 'reset_password' && !existing) {
      throw new NotFoundException({
        code: 'PHONE_NOT_REGISTERED',
        message: '该手机号未注册',
      });
    }
    await this.smsCodes.issue(phone, purpose);
  }

  async register(
    phone: string,
    code: string,
    password: string,
    nickname?: string,
  ): Promise<{ user: SafeUser } & TokenPair> {
    const existing = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });
    if (existing) throw phoneTaken();
    // 先校验并消费验证码，再建用户：验证码错误不留下半成品账号
    await this.smsCodes.verifyAndConsume(phone, 'register', code);
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    let user;
    try {
      user = await this.prisma.user.create({
        data: { phone, passwordHash, nickname: nickname ?? null },
      });
    } catch (err) {
      // users.phone 唯一约束：并发的注册/换号「先查后写」会撞上它，按契约 409 而不是 500（审计 AUTH-03）
      if (isUniqueViolation(err)) throw phoneTaken();
      throw err;
    }
    const tokens = await this.issueTokens(user.id);
    return { user: this.toSafeUser(user), ...tokens };
  }

  async login(
    phone: string,
    password: string,
  ): Promise<{ user: SafeUser } & TokenPair> {
    const user = await this.prisma.user.findUnique({ where: { phone } });
    // 手机号不存在/已注销与密码错误返回同一错误，不给撞库者区分信息
    if (
      !user ||
      user.deletedAt ||
      !(await bcrypt.compare(password, user.passwordHash))
    ) {
      throw unauthorized('手机号或密码错误');
    }
    const tokens = await this.issueTokens(user.id);
    return { user: this.toSafeUser(user), ...tokens };
  }

  /** 找回密码：验证码通过后改密，并撤销该用户全部会话（旧设备需重新登录）。 */
  async resetPassword(
    phone: string,
    code: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException({
        code: 'PHONE_NOT_REGISTERED',
        message: '该手机号未注册',
      });
    }
    await this.smsCodes.verifyAndConsume(phone, 'reset_password', code);
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    this.logger.log(`用户 ${user.id} 已通过验证码重置密码，全部会话已撤销`);
  }

  /** 校验当前用户密码；错误 → 400 PASSWORD_INCORRECT；用户不存在/已注销 → 401（access token 尚未过期的残留会话）。 */
  async verifyPassword(userId: string, password: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, deletedAt: true },
    });
    if (!user || user.deletedAt) throw unauthorized('用户不存在或已注销');
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      throw new BadRequestException({
        code: 'PASSWORD_INCORRECT',
        message: '密码不正确',
      });
    }
  }

  /**
   * 修改密码（已登录）：旧密码校验通过后改密，撤销该用户其他全部会话；
   * keepRefreshToken（当前设备的 refresh token）若属于本人则保留，本设备免重新登录。
   */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
    keepRefreshToken?: string,
  ): Promise<void> {
    await this.verifyPassword(userId, oldPassword);
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // 保留的是这台设备「现役」的那张：App 带来的若是轮换前的旧 token（refresh 应答丢了，手上只剩它），
    // 现役的是它的替代者——原来按旧 token 的哈希保留，等于把这台设备也登出了（10-17 评审 R1-2）
    const keepId = keepRefreshToken
      ? await this.liveDescendant(hashRefreshToken(keepRefreshToken), userId)
      : null;
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash },
      }),
      this.prisma.refreshToken.updateMany({
        // userId 条件同时保证：别人的 token 哈希即使传进来也不会被"保留"
        where: {
          userId,
          revokedAt: null,
          ...(keepId && { id: { not: keepId } }),
        },
        data: { revokedAt: new Date() },
      }),
      // 补发链路（refresh 应答丢失）按 replacedById 认「轮换出来、从没用过」的新 token：当前设备保留的
      // 那张若刚由旧 token 轮换而来，旧 token 15 分钟内还能凭它补发——改密前偷到旧 token 的人就活过了改密
      this.prisma.refreshToken.updateMany({
        where: { userId, replacedById: { not: null } },
        data: { replacedById: null },
      }),
    ]);
    this.logger.log(`用户 ${userId} 已修改密码，其他会话已撤销`);
  }

  /** 换绑手机号（已登录）：当前密码正确 → 新号未注册 → 校验并消费发往新号的 change_phone 验证码 → 改号。 */
  async changePhone(
    userId: string,
    newPhone: string,
    code: string,
    password: string,
  ): Promise<SafeUser> {
    // 先验密码再查号：密码不对时不消费验证码，也不泄露新号是否已注册
    await this.verifyPassword(userId, password);
    const taken = await this.prisma.user.findUnique({
      where: { phone: newPhone },
      select: { id: true },
    });
    if (taken) throw phoneTaken();
    await this.smsCodes.verifyAndConsume(newPhone, 'change_phone', code);
    let user;
    try {
      user = await this.prisma.user.update({
        where: { id: userId },
        data: { phone: newPhone },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw phoneTaken();
      throw err;
    }
    this.logger.log(`用户 ${userId} 已换绑手机号`);
    return this.toSafeUser(user);
  }

  /** refresh 轮换：旧 token 立即作废；已作废 token 再出现：并发窗口内拒绝、补发窗口内补发一次、之后视为盗用撤销全部会话。 */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const tokenHash = hashRefreshToken(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { deletedAt: true } } },
    });
    if (!record) throw unauthorized('refresh token 无效');
    // 注销时已撤销全部 token，这里是兜底：已注销用户不得续期
    if (record.user.deletedAt) throw unauthorized('账号已注销');
    if (record.revokedAt) {
      const revokedAgo = Date.now() - record.revokedAt.getTime();
      if (revokedAgo < REFRESH_CONCURRENT_GRACE_MS) {
        throw unauthorized('refresh token 已被使用，请用最新的 token');
      }
      if (revokedAgo < REFRESH_RETRY_WINDOW_MS) {
        const reissued = await this.reissueAfterLostResponse(record);
        if (reissued) return reissued;
        throw unauthorized('refresh token 已被使用，请用最新的 token');
      }
      // 登出 / 改密 / 重置 / 注销作废的 token 没有替代者：任何时候再出现都只是 401（API.md §2）。
      // 原来一律当盗用撤销全部会话——被改密踢下线的另一台手机几小时后回来，会把用户留下的那台也登出（10-17 评审 R1-1）
      if (!record.replacedById) {
        throw unauthorized('refresh token 已失效，请重新登录');
      }
      // 已轮换掉的 token 过了补发窗口再次出现 = 疑似被盗用，终止该用户所有会话
      this.logger.warn(
        `refresh token 复用检测：撤销用户 ${record.userId} 全部会话`,
      );
      await this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw unauthorized('refresh token 已失效，请重新登录');
    }
    if (record.expiresAt.getTime() < Date.now()) {
      throw unauthorized('refresh token 已过期，请重新登录');
    }
    // 条件轮换：同一 token 并发刷新只有一方成功，输家拿 401 但不触发全局撤销（那是良性竞态，不是盗用）。
    // 作废旧的、签发新的、记替代关系三步在一个事务里：进程倒在中间不会留下「旧的已作废、新的没发出、
    // 也补发不了」的死会话（10-06 并发评审 #6）
    const pair = await this.prisma.$transaction(async (tx) => {
      await lockUserRow(tx, record.userId);
      const rotated = await tx.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (rotated.count === 0) return null;
      return this.issueTokens(record.userId, record.id, tx);
    });
    if (!pair) throw unauthorized('refresh token 已被使用，请用最新的 token');
    return pair;
  }

  /**
   * 旧 token 在补发窗口内再次出现：只有「轮换出来、从没用过」的那张新 token 才能换——
   * 登出 / 改密作废的 token 没有替代者，照常拒绝；新 token 已被用过（正常轮换走了）或这张旧 token
   * 已补发过一次，再出现就是复用，也拒绝。能换则作废那张新 token、补发一张，不把它记成替代者，
   * 所以同一张旧 token 第二次来时 updateMany 命中 0 行。
   */
  private async reissueAfterLostResponse(record: {
    id: string;
    userId: string;
    replacedById: string | null;
  }): Promise<TokenPair | null> {
    const replacedById = record.replacedById;
    if (!replacedById) return null;
    const pair = await this.prisma.$transaction(async (tx) => {
      await lockUserRow(tx, record.userId);
      const taken = await tx.refreshToken.updateMany({
        where: { id: replacedById, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (taken.count === 0) return null;
      return this.issueTokens(record.userId, undefined, tx);
    });
    if (!pair) return null;
    this.logger.log(
      `refresh 应答疑似丢失：为用户 ${record.userId} 补发 token，作废未用过的 ${record.replacedById}`,
    );
    return pair;
  }

  /**
   * 登出：作废指定 refresh token（幂等——不存在也返回成功）。
   * 带来的若是轮换前的旧 token（refresh 应答丢了，App 手上只剩它），这台设备现役的是它的替代者：一并作废，
   * 并清掉替代关系让旧 token 不能再凭它补发。原来只处理「还活着的」这张，旧 token 登出等于什么都没做——
   * 替代者再活 30 天，旧 token 15 分钟内还能补发新会话（10-17 评审 R1-2）。
   */
  async logout(refreshToken: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      let row = await tx.refreshToken.findUnique({
        where: { tokenHash: hashRefreshToken(refreshToken) },
        select: { id: true, replacedById: true },
      });
      // 沿替代链往下（同一台设备连续丢应答时不止一跳），跳数有上限防环
      for (let hop = 0; row && hop < MAX_REPLACEMENT_HOPS; hop += 1) {
        await tx.refreshToken.updateMany({
          where: { id: row.id, revokedAt: null },
          data: { revokedAt: now },
        });
        if (!row.replacedById) break;
        await tx.refreshToken.update({
          where: { id: row.id },
          data: { replacedById: null },
        });
        row = await tx.refreshToken.findUnique({
          where: { id: row.replacedById },
          select: { id: true, replacedById: true },
        });
      }
    });
  }

  /** 沿替代链找到这台设备现役（未作废、未过期）的那张 token 的 id；链上都已作废返回 null（只认本人的） */
  private async liveDescendant(
    tokenHash: string,
    userId: string,
  ): Promise<string | null> {
    let row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        revokedAt: true,
        expiresAt: true,
        replacedById: true,
      },
    });
    for (let hop = 0; row && hop < MAX_REPLACEMENT_HOPS; hop += 1) {
      if (row.userId !== userId) return null;
      if (!row.revokedAt && row.expiresAt.getTime() > Date.now()) return row.id;
      if (!row.replacedById) return null;
      row = await this.prisma.refreshToken.findUnique({
        where: { id: row.replacedById },
        select: {
          id: true,
          userId: true,
          revokedAt: true,
          expiresAt: true,
          replacedById: true,
        },
      });
    }
    return null;
  }

  /** 签发一对新 token；replacesId = 本次轮换作废的旧 token，记下替代关系供应答丢失时补发 */
  private async issueTokens(
    userId: string,
    replacesId?: string,
    db: Pick<PrismaService, 'refreshToken'> = this.prisma,
  ): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync({ sub: userId });
    // refresh 用不透明随机串（非 JWT）：可撤销、可轮换，库中只存哈希
    const refreshToken = randomBytes(48).toString('base64url');
    const created = await db.refreshToken.create({
      data: {
        userId,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
      select: { id: true },
    });
    if (replacesId) {
      await db.refreshToken.update({
        where: { id: replacesId },
        data: { replacedById: created.id },
      });
    }
    return { accessToken, refreshToken };
  }

  private toSafeUser(u: {
    id: string;
    phone: string;
    nickname: string | null;
    avatarUrl: string | null;
    createdAt: Date;
  }): SafeUser {
    return {
      id: u.id,
      phone: u.phone,
      nickname: u.nickname,
      avatarUrl: u.avatarUrl,
      createdAt: u.createdAt,
    };
  }
}
