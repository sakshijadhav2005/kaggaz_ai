import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:timezone/data/latest.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

import '../interfaces.dart';

class LocalReminderScheduler implements ReminderScheduler {
  final _plugin = FlutterLocalNotificationsPlugin();

  Future<void> init() async {
    tzdata.initializeTimeZones();
    await _plugin.initialize(const InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      iOS: DarwinInitializationSettings(),
    ));
    await _plugin
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
        ?.requestNotificationsPermission();
  }

  @override
  Future<void> schedule(int id, String title, DateTime at) => _plugin.zonedSchedule(
        id,
        'Kaagaz reminder',
        title,
        // Built from the absolute instant, so the device's local zone does not matter.
        tz.TZDateTime.from(at, tz.UTC),
        const NotificationDetails(android: AndroidNotificationDetails('reminders', 'Reminders')),
        androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
        uiLocalNotificationDateInterpretation: UILocalNotificationDateInterpretation.absoluteTime,
      );

  @override
  Future<void> cancel(int id) => _plugin.cancel(id);
}
