import { Component } from '@angular/core';
import { cosmos, deploymentUnits, serviceBus, storage } from '@vg/enterprise-contracts';

/**
 * Static view of the notification topology these customers sit on. The gateway publishes no
 * notification endpoint, so the page is built from the shared contract package's topology
 * constants instead of from an API call the platform does not offer.
 */
@Component({
  selector: 'app-notification-list',
  templateUrl: './notifications.component.html',
})
export class NotificationListComponent {
  protected readonly entries = [
    { label: 'Order events topic', value: serviceBus.orderEventsTopic },
    { label: 'Notifications subscription', value: serviceBus.notificationsSubscription },
    { label: 'Notification requests queue', value: serviceBus.notificationRequestsQueue },
    { label: 'Payload container', value: storage.notificationPayloadsContainer },
    { label: 'Preferences container', value: cosmos.customersContainer },
    { label: 'Delivering unit', value: deploymentUnits.notificationService },
  ];
}
