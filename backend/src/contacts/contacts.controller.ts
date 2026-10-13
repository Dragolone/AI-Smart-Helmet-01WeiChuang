import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { PHONE_PATTERN } from '../common/phone';
import { ContactsService } from './contacts.service';

// 联系人名会原样进 SOS 短信文案，全空白名不能入库：先 trim 再验最小长度
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

class CreateContactDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  name!: string;

  @Matches(PHONE_PATTERN, { message: 'phone 必须是有效的大陆手机号' })
  phone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  relation?: string;
}

// name / phone 是必填列：只有「没传」可以跳过校验；IsOptional 连 null 也放过，写库时才炸成 500
const present = (_: object, value: unknown) => value !== undefined;

class UpdateContactDto {
  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  name?: string;

  @ValidateIf(present)
  @Matches(PHONE_PATTERN, { message: 'phone 必须是有效的大陆手机号' })
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  relation?: string;
}

@Controller('users/me/emergency-contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.contacts.list(req.user.userId);
  }

  @Post()
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateContactDto) {
    return this.contacts.create(req.user.userId, dto);
  }

  @Patch(':contactId')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('contactId') contactId: string,
    @Body() dto: UpdateContactDto,
  ) {
    return this.contacts.update(req.user.userId, contactId, dto);
  }

  @Delete(':contactId')
  @HttpCode(204)
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('contactId') contactId: string,
  ): Promise<void> {
    await this.contacts.remove(req.user.userId, contactId);
  }
}
