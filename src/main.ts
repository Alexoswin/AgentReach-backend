import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Enable CORS for frontend requests
  app.enableCors();
  
  // Set global API prefix
  app.setGlobalPrefix('api');

  // Set up Swagger API Documentation
  const config = new DocumentBuilder()
    .setTitle('ReachConvert API')
    .setDescription('ReachConvert outreach platform API endpoints')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3001);
  await app.listen(port);
  console.log(`Backend is running on: http://localhost:${port}/api`);
  console.log(`Swagger documentation is available at: http://localhost:${port}/docs`);
}
void bootstrap();
