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
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { ContactsService } from './contacts.service';

// 与 Auth 注册同口径的大陆手机号；SOS 短信直发此号码，入口必须挡住脏数据
const PHONE_PATTERN = /^1[3-9]\d{9}$/;

class CreateContactDto {
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

class UpdateContactDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  name?: string;

  @IsOptional()
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
